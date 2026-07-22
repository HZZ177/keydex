import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronRight,
  Code2,
  Columns2,
  Copy,
  Eye,
  Maximize2,
  Search,
  MessageSquarePlus,
  MessageSquareText,
  RotateCcw,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { css as cssLanguage } from "@codemirror/lang-css";
import { html as htmlLanguage } from "@codemirror/lang-html";
import { javascript } from "@codemirror/lang-javascript";
import { json as jsonLanguage } from "@codemirror/lang-json";
import { markdown as markdownLanguage } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";
import { sql } from "@codemirror/lang-sql";
import { xml } from "@codemirror/lang-xml";
import { yaml } from "@codemirror/lang-yaml";
import {
  bracketMatching,
  foldGutter,
  foldKeymap,
  HighlightStyle,
  indentOnInput,
  syntaxHighlighting,
} from "@codemirror/language";
import { highlightSelectionMatches, search, SearchQuery, setSearchQuery } from "@codemirror/search";
import { Compartment, EditorSelection, EditorState, type Extension } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  lineNumbers,
  EditorView,
  keymap,
} from "@codemirror/view";
import { tags } from "@lezer/highlight";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  memo,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type HTMLAttributes,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  type ReactNode,
  type WheelEvent as ReactWheelEvent,
} from "react";
import { createPortal } from "react-dom";

import {
  createDocumentWriteId,
  isRuntimeHttpError,
  type DocumentWriteResult,
  type RuntimeBridge,
  type WorkspaceMediaResponse,
  type WorkspaceScope,
} from "@/runtime";
import { AppDialog } from "@/renderer/components/dialog";
import { SelectionToolbar } from "@/renderer/pages/conversation/messages/SelectionToolbar";
import { copyText } from "@/renderer/pages/conversation/messages/markdown";
import { useTextSelection, type SelectionPosition } from "@/renderer/pages/conversation/messages/useTextSelection";
import { useCopyFeedback } from "@/renderer/hooks/useCopyFeedback";
import {
  APP_FIND_SHORTCUT_EVENT,
  isFindShortcutEvent,
  type AppFindShortcutDetail,
} from "@/renderer/events/findShortcut";
import { subscribeStartWorkspaceFileAnnotation } from "@/renderer/events/workspaceFileContext";
import {
  useOptionalPreview,
  type PreviewAnnotationChatRequest,
  type PreviewFileRevealTarget,
  type PreviewQuoteSelectionRequest,
} from "@/renderer/providers/PreviewProvider";
import { useOptionalFileChanges } from "@/renderer/providers/FileChangeProvider";
import { useNotifications } from "@/renderer/providers/NotificationProvider";
import { LoadingSkeleton } from "@/renderer/components/loading";
import type { PreviewContentKind, PreviewMarkdownViewDescriptor, PreviewRequest } from "@/renderer/providers/previewTypes";
import {
  centerMermaidViewport,
  formatMermaidCssPixels,
  normalizeMermaidSvgDimensions,
  preserveMermaidZoomAnchor,
  syncMermaidCanvasPadding,
  type SvgDimensions,
} from "@/renderer/utils/mermaidSvg";
import { getMermaidConfig } from "@/renderer/utils/mermaidConfig";
import {
  isAbsoluteFilePath,
  resolveRelativeFileLinkPath,
  workspaceAbsoluteFilePath,
} from "@/renderer/utils/fileLinks";
import {
  HTML_PREVIEW_VIEWPORT_MESSAGE_TYPE,
  resolveHtmlPreviewFrameSource,
} from "@/renderer/utils/htmlPreviewFrame";
import { openSkillResourcePreview, skillResourcePreviewError } from "@/renderer/utils/skillResourcePreview";
import {
  diffDocumentRawSource,
  normalizeDiffPreviewRequest,
} from "@/renderer/components/diff/adapters/previewDocument";
import { PreviewDiffView } from "@/renderer/components/diff/wrappers/PreviewDiffView";

import { AnnotationRail } from "@/renderer/features/annotations/ui/AnnotationRail";
import { AnnotationStatusSection } from "@/renderer/features/annotations/ui/AnnotationStatusSection";
import { DocumentAnnotationSection } from "@/renderer/features/annotations/ui/DocumentAnnotationSection";
import { AnnotationRetargetCard } from "@/renderer/features/annotations/ui/AnnotationRetargetCard";
import { AnnotationConnectorLayer } from "@/renderer/features/annotations/ui/AnnotationConnectorLayer";
import {
  restartAnnotationNavigationFlash,
  smoothScrollElementTo,
} from "@/renderer/features/annotations/navigation/AnnotationNavigationEffects";
import {
  connectorGeometry,
  connectorPreferredEdgeY,
  spreadConnectorEdgePorts,
} from "@/renderer/features/annotations/layout/ConnectorGeometry";
import { markerAnchorPoint } from "@/renderer/features/annotations/layout/DocumentGeometry";
import {
  DRAFT_ANNOTATION_ID,
  RETARGET_ANNOTATION_ID,
  useUnifiedAnnotationSession,
  type UnifiedAnnotationSession,
} from "@/renderer/features/annotations/state/useUnifiedAnnotationSession";
import type { SourceAnnotationAdapter } from "@/renderer/features/annotations/adapters/SourceAnnotationAdapter";
import type { DocumentSelection } from "@/renderer/features/annotations/document/DocumentTextModel";
import type {
  AnnotationDocumentWorkerResolveInput,
  AnnotationDocumentWorkerResolver,
} from "@/renderer/features/annotations/anchoring/DocumentWorkerAnnotationResolver";
import { ImagePreviewSurface } from "./ImagePreviewSurface";
import {
  FileMarkdownRuntimeHost,
  type FileMarkdownRuntimeHostHandle,
  type FileMarkdownRuntimeSnapshotLoader,
} from "./FileMarkdownRuntimeHost";
import { FilePreviewBottomScrollSpace } from "./FilePreviewBottomScrollSpace";
import {
  codeMirrorViewportSourceAnchor,
  syncCodeMirrorViewportToSourceAnchor,
  type SourceLineScrollAnchor,
} from "./splitViewScrollSync";
import type {
  MarkdownSnapshot,
  MarkdownSnapshotOutlineEntry,
} from "@/renderer/markdownRuntime/document/MarkdownSnapshot";
import type { MarkdownFindIndex as RuntimeMarkdownFindIndex } from "@/renderer/markdownRuntime/find";
import type { MarkdownProjectedSelection } from "@/renderer/markdownRuntime/interaction";
import {
  resolveMarkdownLinkTarget,
  type MarkdownResolvedLinkTarget,
} from "@/renderer/markdownRuntime/interaction/InteractionController";
import type { MarkdownRendererInteractionHandlers } from "@/renderer/markdownRuntime/renderers";
import { stableMarkdownIdentityHash } from "@/renderer/markdownRuntime/document/identity";
import { markdownRuntimeDiagnostics } from "@/renderer/markdownRuntime/diagnostics";
import styles from "./FilePreview.module.css";

export type FilePreviewRequest = PreviewRequest;

const EMPTY_ANNOTATION_FLOATING_ITEMS = Object.freeze([]);
const ANNOTATION_RAIL_CARD_INSET = 32;
const ANNOTATION_CONNECTOR_FAN_OUT = 8;
const ANNOTATION_BOTTOM_ACTIONS_RESERVED = 68;
const FILE_PREVIEW_BOTTOM_PROXIMITY_MIN_PX = 72;
const FILE_PREVIEW_BOTTOM_PROXIMITY_MAX_PX = 160;

interface ResourceAnnotationVisualState {
  readonly active: boolean;
  readonly highlighted: boolean;
  readonly hovered: boolean;
}

interface PendingViewModeScrollRestore {
  readonly requestIdentity: string;
  readonly targetMode: "preview" | "source";
  readonly anchor: SourceLineScrollAnchor;
}

type FileAutoSaveState = "idle" | "dirty" | "saving" | "saved" | "conflict" | "error";

const FILE_SAVE_CONFLICT_MESSAGE = "文件已被外部修改，自动保存已暂停。你的编辑仍保留在当前视图中。";

interface FileDraft {
  readonly baseRevision: string;
  readonly content: string;
}

const EMPTY_RESOURCE_ANNOTATION_VISUAL_STATE: ResourceAnnotationVisualState = Object.freeze({
  active: false,
  highlighted: false,
  hovered: false,
});

export interface MarkdownOutlineItem {
  id: string;
  level: number;
  line: number;
  title: string;
}

export interface MarkdownOutlineRevealRequest {
  requestId: number;
  id: string;
  line: number;
}

export interface FilePreviewRevealRequest extends PreviewFileRevealTarget {
  requestId: number;
}

export interface FilePreviewProps {
  workspaceId?: string;
  workspaceRootPath?: string;
  sessionId?: string;
  workspaceAnnotationPath?: string | null;
  request: FilePreviewRequest;
  runtime?: RuntimeBridge;
  onQuoteSelection?: (request: PreviewQuoteSelectionRequest) => void;
  onStartChatFromAnnotation?: (request: PreviewAnnotationChatRequest | PreviewAnnotationChatRequest[]) => void;
  onMarkdownOutlineChange?: (outline: MarkdownOutlineItem[]) => void;
  onViewportNearBottomChange?: (nearBottom: boolean) => void;
  outlineRevealRequest?: MarkdownOutlineRevealRequest | null;
  sourceRevealRequest?: FilePreviewRevealRequest | null;
  onClose?: () => void;
  chrome?: "default" | "panel";
  breadcrumbRootLabel?: string;
  hideBreadcrumbs?: boolean;
  markdownRuntimeSnapshotLoader?: FileMarkdownRuntimeSnapshotLoader;
  markdownViewDescriptor?: PreviewMarkdownViewDescriptor;
  refreshRequestId?: number;
}

declare global {
  // New-Runtime component-test oracle. Production builds never read this hook.
  var __KEYDEX_TEST_FILE_MARKDOWN_SNAPSHOT_LOADER__: FileMarkdownRuntimeSnapshotLoader | undefined;
}

export function FilePreview({
  workspaceId,
  workspaceRootPath,
  sessionId,
  workspaceAnnotationPath,
  request,
  runtime,
  onQuoteSelection,
  onStartChatFromAnnotation,
  onMarkdownOutlineChange,
  onViewportNearBottomChange,
  outlineRevealRequest,
  sourceRevealRequest,
  onClose,
  chrome = "default",
  breadcrumbRootLabel,
  hideBreadcrumbs = false,
  markdownRuntimeSnapshotLoader,
  markdownViewDescriptor,
  refreshRequestId = 0,
}: FilePreviewProps) {
  const notifications = useNotifications();
  const effectiveMarkdownRuntimeSnapshotLoader = markdownRuntimeSnapshotLoader
    ?? (import.meta.env.MODE === "test" ? globalThis.__KEYDEX_TEST_FILE_MARKDOWN_SNAPSHOT_LOADER__ : undefined);
  const previewRootRef = useRef<HTMLElement | null>(null);
  const annotationLayoutRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [documentViewport, setDocumentViewport] = useState<HTMLDivElement | null>(null);
  const documentViewportRef = useRef<HTMLDivElement | null>(null);
  const [splitSourceViewport, setSplitSourceViewport] = useState<HTMLDivElement | null>(null);
  const [splitPreviewViewport, setSplitPreviewViewport] = useState<HTMLDivElement | null>(null);
  const [htmlFrameElement, setHtmlFrameElement] = useState<HTMLIFrameElement | null>(null);
  const [annotationRailElement, setAnnotationRailElement] = useState<HTMLElement | null>(null);
  const lastViewportNearBottomRef = useRef<boolean | null>(null);
  const splitScrollOwnerRef = useRef<"source" | "preview">("source");
  const pendingScrollRestoreRef = useRef<number | null>(null);
  const pendingViewModeScrollRestoreRef = useRef<PendingViewModeScrollRestore | null>(null);
  const setDocumentViewportElement = useCallback((element: HTMLDivElement | null) => {
    documentViewportRef.current = element;
    setDocumentViewport(element);
  }, []);
  const [annotationActionsHost, setAnnotationActionsHost] = useState<HTMLDivElement | null>(null);
  const markdownRuntimeHostRef = useRef<FileMarkdownRuntimeHostHandle | null>(null);
  const findInputRef = useRef<HTMLInputElement | null>(null);
  const panelChrome = chrome === "panel";
  const usesFileOpenDelay = panelChrome && isPathPreviewRequest(request);
  const kind = useMemo(() => detectPreviewKind(request), [request]);
  const canonicalDiffRequest = useMemo(() => {
    const normalized = normalizeDiffPreviewRequest(request);
    return normalized.type === "diff-document" ? normalized : null;
  }, [request]);
  const immediateContent = useMemo(() => immediatePreviewContent(request), [request]);
  const [content, setContent] = useState(() => immediatePreviewContent(request) ?? "");
  const [persistedContent, setPersistedContent] = useState(() => immediatePreviewContent(request) ?? "");
  const draftsRef = useRef(new Map<string, FileDraft>());
  const activeRequestIdentityRef = useRef("");
  const hasUnsavedChangesRef = useRef(false);
  const saveInFlightRef = useRef(false);
  const lastAutoSaveNotificationKeyRef = useRef<string | null>(null);
  const [autoSaveState, setAutoSaveState] = useState<FileAutoSaveState>("idle");
  const [conflictRevision, setConflictRevision] = useState<string | null>(null);
  const [conflictDialogOpen, setConflictDialogOpen] = useState(false);
  const [saveQueueVersion, setSaveQueueVersion] = useState(0);
  const [documentRevision, setDocumentRevision] = useState<string | null>(null);
  const [media, setMedia] = useState<WorkspaceMediaResponse | null>(null);
  const [loading, setLoading] = useState(isPathPreviewRequest(request));
  const [reloading, setReloading] = useState(false);
  const [reloadError, setReloadError] = useState<string | null>(null);
  const [fileUnavailable, setFileUnavailable] = useState(false);
  const [reloadVersion, setReloadVersion] = useState(0);
  const hasLoadedRef = useRef(immediatePreviewContent(request) !== null);
  const requestIdentityRef = useRef<string | null>(null);
  const handledRefreshRequestIdRef = useRef(refreshRequestId);
  const [fileOpenSettling, setFileOpenSettling] = useState(usesFileOpenDelay);
  const previewContent = immediateContent ?? content;
  const previewLoading = immediateContent === null ? loading : false;
  const [error, setError] = useState<string | null>(null);
  const directHtmlPreviewPath = useMemo(() => {
    if (
      kind !== "html"
      || previewLoading
      || (request.type !== "file" && request.type !== "local-file")
    ) {
      return null;
    }
    const detectedFrameSource = resolveHtmlPreviewFrameSource(
      previewContent || "<p>文件为空</p>",
      { sourcePath: request.path },
    );
    if (detectedFrameSource.kind === "url") {
      return null;
    }
    if (request.type === "file" && !workspaceRootPath) {
      return null;
    }
    return workspaceAbsoluteFilePath(request.path, workspaceRootPath ?? "");
  }, [kind, previewContent, previewLoading, request, workspaceRootPath]);
  const prepareHtmlFile = runtime?.localPreview?.prepareHtmlFile;
  const directHtmlPreviewScopePath = request.type === "file" ? workspaceRootPath : undefined;
  const [directHtmlPreview, setDirectHtmlPreview] = useState<{
    error: string | null;
    path: string;
    status: "loading" | "ready" | "error";
    url: string | null;
  } | null>(null);
  useEffect(() => {
    if (!directHtmlPreviewPath || !prepareHtmlFile) {
      setDirectHtmlPreview(null);
      return;
    }
    let active = true;
    setDirectHtmlPreview({
      error: null,
      path: directHtmlPreviewPath,
      status: "loading",
      url: null,
    });
    void prepareHtmlFile(directHtmlPreviewPath, directHtmlPreviewScopePath)
      .then((result) => {
        if (!active) return;
        setDirectHtmlPreview({
          error: null,
          path: directHtmlPreviewPath,
          status: "ready",
          url: result.url,
        });
      })
      .catch((reason) => {
        if (!active) return;
        const message = reason instanceof Error ? reason.message : String(reason);
        setDirectHtmlPreview({
          error: `HTML 直接预览初始化失败：${message || "未知错误"}。请重启 Keydex 本地服务后重试。`,
          path: directHtmlPreviewPath,
          status: "error",
          url: null,
        });
      });
    return () => {
      active = false;
    };
  }, [directHtmlPreviewPath, directHtmlPreviewScopePath, prepareHtmlFile]);
  const directHtmlPreviewMatches = directHtmlPreview?.path === directHtmlPreviewPath;
  const directHtmlPreviewPreparing = Boolean(
    directHtmlPreviewPath
      && prepareHtmlFile
      && (!directHtmlPreviewMatches || directHtmlPreview?.status === "loading"),
  );
  const directHtmlPreviewUrl = directHtmlPreviewMatches && directHtmlPreview?.status === "ready"
    ? directHtmlPreview.url
    : null;
  const directHtmlPreviewError = directHtmlPreviewMatches && directHtmlPreview?.status === "error"
    ? directHtmlPreview.error
    : directHtmlPreviewPath && !prepareHtmlFile
      ? "HTML 直接预览运行时尚未更新，请刷新 Keydex 页面后重新打开文件。"
      : null;
  const [markdownRuntimeSnapshot, setMarkdownRuntimeSnapshot] = useState<MarkdownSnapshot | null>(null);
  const [markdownRuntimeSource, setMarkdownRuntimeSource] = useState<string | null>(null);
  const [markdownRuntimePublishVersion, setMarkdownRuntimePublishVersion] = useState(0);
  const [markdownRuntimeError, setMarkdownRuntimeError] = useState<Error | null>(null);
  const [markdownRuntimeFindIndex, setMarkdownRuntimeFindIndex] = useState<RuntimeMarkdownFindIndex | null>(null);
  const [markdownRuntimeSelection, setMarkdownRuntimeSelection] = useState<MarkdownProjectedSelection | null>(null);
  const [runtimeMermaidPreviewCode, setRuntimeMermaidPreviewCode] = useState<string | null>(null);
  const publishMarkdownRuntimeSnapshot = useCallback((snapshot: MarkdownSnapshot, source: string) => {
    setMarkdownRuntimeSnapshot(snapshot);
    setMarkdownRuntimeSource(source);
    setMarkdownRuntimePublishVersion((version) => version + 1);
    const scrollTop = pendingScrollRestoreRef.current;
    if (scrollTop === null) {
      return;
    }
    window.requestAnimationFrame(() => {
      if (documentViewportRef.current) {
        documentViewportRef.current.scrollTop = scrollTop;
      }
      pendingScrollRestoreRef.current = null;
    });
  }, []);
  const previewBusy = previewLoading || fileOpenSettling || directHtmlPreviewPreparing;
  const [viewMode, setViewMode] = useState<"preview" | "source">("preview");
  const [splitMode, setSplitMode] = useState(false);
  const { copyState, showCopyFeedback, resetCopyFeedback } = useCopyFeedback();
  const [theme, setTheme] = useState<"light" | "dark">(() => getTheme());
  const previewContext = useOptionalPreview();
  const fileChanges = useOptionalFileChanges();
  const previewEntries = previewContext?.entries ?? [];
  const activePreviewId = previewContext?.activeEntryId ?? null;
  const showPreviewTabs = previewEntries.length > 1;
  const scope = useMemo(() => workspaceScope({ workspaceId, sessionId }), [workspaceId, sessionId]);
  const fileLoadScope = request.type === "file" ? scope : null;
  const requestIdentity = previewRequestIdentity(request, workspaceId, sessionId);
  const livePreviewRevision = documentRevision ?? `inline:${stableMarkdownIdentityHash(previewContent)}`;
  const [splitPreviewSnapshot, setSplitPreviewSnapshot] = useState(() => ({
    content: previewContent,
    requestIdentity,
    revision: livePreviewRevision,
  }));
  const renderedPreviewContent = splitMode && splitPreviewSnapshot.requestIdentity === requestIdentity
    ? splitPreviewSnapshot.content
    : previewContent;
  const renderedPreviewRevision = splitMode && splitPreviewSnapshot.requestIdentity === requestIdentity
    ? splitPreviewSnapshot.revision
    : livePreviewRevision;
  const renderedDiffRequest = useMemo(() => {
    if (canonicalDiffRequest) return canonicalDiffRequest;
    if (kind !== "diff" || !isPathPreviewRequest(request) || previewLoading) return null;
    const normalized = normalizeDiffPreviewRequest({
      type: "content",
      title: fileName(request.path),
      content: renderedPreviewContent,
      contentType: "diff",
      sourcePath: request.path,
    });
    return normalized.type === "diff-document" ? normalized : null;
  }, [canonicalDiffRequest, kind, previewLoading, renderedPreviewContent, request]);
  useEffect(() => {
    const revision = previewContent === persistedContent
      ? livePreviewRevision
      : `draft:${stableMarkdownIdentityHash(previewContent)}`;
    const updateSnapshot = () => {
      setSplitPreviewSnapshot((current) => {
        if (
          current.requestIdentity === requestIdentity
          && current.content === previewContent
          && current.revision === revision
        ) {
          return current;
        }
        return { content: previewContent, requestIdentity, revision };
      });
    };
    if (!splitMode || splitPreviewSnapshot.requestIdentity !== requestIdentity) {
      updateSnapshot();
      return;
    }
    if (splitPreviewSnapshot.content === previewContent) {
      return;
    }
    const timer = window.setTimeout(updateSnapshot, FILE_PREVIEW_SPLIT_RENDER_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [
    livePreviewRevision,
    persistedContent,
    previewContent,
    requestIdentity,
    splitMode,
    splitPreviewSnapshot.content,
    splitPreviewSnapshot.requestIdentity,
  ]);
  activeRequestIdentityRef.current = requestIdentity;
  const editable = Boolean(
    isPathPreviewRequest(request)
    && kind !== "image"
    && kind !== "diff"
    && runtime
    && (request.type === "local-file"
      ? typeof runtime.localPreview?.writeDocument === "function"
      : Boolean(fileLoadScope && typeof runtime.workspace?.writeDocument === "function")),
  );
  const hasUnsavedChanges = editable && content !== persistedContent;
  hasUnsavedChangesRef.current = hasUnsavedChanges;
  const notifyAutoSaveError = useCallback((key: string, message: string) => {
    const notificationKey = `${requestIdentity}:${key}`;
    if (lastAutoSaveNotificationKeyRef.current === notificationKey) return;
    lastAutoSaveNotificationKeyRef.current = notificationKey;
    notifications.error(message);
  }, [notifications, requestIdentity]);
  const annotationPathCandidate = workspaceAnnotationPath === undefined
    ? request.type === "file" ? request.path : null
    : workspaceAnnotationPath;
  const annotationPath = annotationPathCandidate && !isAbsoluteFilePath(annotationPathCandidate)
    ? annotationPathCandidate
    : null;
  const revealPath = isPathPreviewRequest(request)
    ? request.path
    : request.type === "content"
      ? request.sourcePath ?? null
      : null;
  const quoteSelectionAvailable = Boolean(onQuoteSelection && annotationPath && !fileUnavailable);
  const sourceSelectionRef = useRef<SourceSelection | null>(null);
  const updateSourceSelection = useCallback((nextSelection: SourceSelection | null) => {
    if (!sourceSelectionsEqual(sourceSelectionRef.current, nextSelection)) {
      sourceSelectionRef.current = nextSelection;
    }
  }, []);
  const [lineRevealRequest, setLineRevealRequest] = useState<SourceLineRevealRequest | null>(null);
  const [sourceEditorView, setSourceEditorView] = useState<EditorView | null>(null);
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [findFocusRequestId, setFindFocusRequestId] = useState(0);
  const [findMatchCount, setFindMatchCount] = useState(0);
  const [findMatchIndex, setFindMatchIndex] = useState(-1);
  const [activeMarkdownFindMatchId, setActiveMarkdownFindMatchId] = useState<string | null>(null);
  const [sourceFindState, setSourceFindState] = useState<CodeMirrorFindState | null>(null);
  const handledAnnotationRevealRequestIdsRef = useRef(new Map<string, number>());
  const handledSourceRevealRequestIdsRef = useRef(new Map<string, number>());
  const lastFindScrollLineRef = useRef<FilePreviewFindScrollLine | null>(null);
  const documentReadConsumerIdRef = useRef(`file-preview-${nextFilePreviewConsumerId++}`);
  const standaloneMarkdownViewIdRef = useRef(`file-preview-${nextFilePreviewViewId++}`);

  const reloadCurrentFile = useCallback(() => {
    if (!isPathPreviewRequest(request)) {
      return;
    }
    if (documentViewportRef.current) {
      pendingScrollRestoreRef.current = documentViewportRef.current.scrollTop;
    }
    setReloadVersion((version) => version + 1);
  }, [requestIdentity]);

  const updateDraftContent = useCallback((nextContent: string) => {
    if (!editable || !documentRevision) return;
    splitScrollOwnerRef.current = "source";
    setContent(nextContent);
    if (autoSaveState === "error") {
      lastAutoSaveNotificationKeyRef.current = null;
    }
    const existing = draftsRef.current.get(requestIdentity);
    if (nextContent === persistedContent) {
      draftsRef.current.delete(requestIdentity);
      setAutoSaveState("saved");
      return;
    }
    draftsRef.current.set(requestIdentity, {
      baseRevision: existing?.baseRevision ?? documentRevision,
      content: nextContent,
    });
    if (autoSaveState !== "conflict") {
      setAutoSaveState("dirty");
    }
  }, [autoSaveState, documentRevision, editable, persistedContent, requestIdentity]);

  const saveDraft = useCallback(async (expectedRevisionOverride?: string) => {
    if (!editable || !runtime || !isPathPreviewRequest(request) || saveInFlightRef.current || fileUnavailable) return;
    const identity = requestIdentity;
    const draft = draftsRef.current.get(identity);
    if (!draft) return;
    if (autoSaveState === "conflict" && !expectedRevisionOverride) return;

    const expectedRevision = expectedRevisionOverride ?? draft.baseRevision;
    const writeId = createDocumentWriteId();
    const unregisterDocumentWrite = fileChanges?.registerDocumentWrite(writeId);
    let writeSucceeded = false;
    saveInFlightRef.current = true;
    if (activeRequestIdentityRef.current === identity) {
      if (autoSaveState === "error") {
        lastAutoSaveNotificationKeyRef.current = null;
      }
      setAutoSaveState("saving");
    }
    let result: DocumentWriteResult;
    try {
      result = request.type === "local-file"
        ? await runtime.localPreview.writeDocument(request.path, draft.content, { expectedRevision, writeId })
        : await runtime.workspace.writeDocument(fileLoadScope as WorkspaceScope, request.path, draft.content, {
            expectedRevision,
            writeId,
          });
      writeSucceeded = true;
      const latest = draftsRef.current.get(identity);
      if (!latest || latest.content === draft.content) {
        draftsRef.current.delete(identity);
      } else {
        draftsRef.current.set(identity, { ...latest, baseRevision: result.revision });
      }
      if (activeRequestIdentityRef.current === identity) {
        lastAutoSaveNotificationKeyRef.current = null;
        setPersistedContent(draft.content);
        setDocumentRevision(result.revision);
        setConflictRevision(null);
        setConflictDialogOpen(false);
        setAutoSaveState(latest && latest.content !== draft.content ? "dirty" : "saved");
      }
    } catch (reason) {
      const activeIdentity = activeRequestIdentityRef.current === identity;
      if (isRuntimeHttpError(reason) && reason.code === "revision_conflict") {
        const actualRevision = typeof reason.details?.actual_revision === "string"
          ? reason.details.actual_revision
          : null;
        if (activeIdentity) {
          setConflictRevision(actualRevision);
          setConflictDialogOpen(true);
          setAutoSaveState("conflict");
          reloadCurrentFile();
        }
        notifyAutoSaveError("conflict", FILE_SAVE_CONFLICT_MESSAGE);
        return;
      }
      const message = `自动保存失败：${errorMessage(reason)}`;
      if (activeIdentity) {
        setAutoSaveState("error");
      }
      notifyAutoSaveError(`write:${message}`, message);
    } finally {
      if (!writeSucceeded) unregisterDocumentWrite?.();
      saveInFlightRef.current = false;
      setSaveQueueVersion((version) => version + 1);
    }
  }, [
    autoSaveState,
    editable,
    fileChanges,
    fileLoadScope,
    fileUnavailable,
    notifyAutoSaveError,
    reloadCurrentFile,
    request,
    requestIdentity,
    runtime,
  ]);

  useEffect(() => () => {
    void saveDraft();
  }, [requestIdentity]);

  useEffect(() => {
    if (
      !hasUnsavedChanges
      || autoSaveState === "saving"
      || autoSaveState === "conflict"
      || autoSaveState === "error"
    ) return;
    const timer = window.setTimeout(() => void saveDraft(), FILE_PREVIEW_AUTO_SAVE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [autoSaveState, content, hasUnsavedChanges, saveDraft, saveQueueVersion]);

  const discardDraftAndReload = useCallback(() => {
    draftsRef.current.delete(requestIdentity);
    setConflictDialogOpen(false);
    setConflictRevision(null);
    lastAutoSaveNotificationKeyRef.current = null;
    setAutoSaveState("idle");
    reloadCurrentFile();
  }, [reloadCurrentFile, requestIdentity]);

  const overwriteConflictingDocument = useCallback(() => {
    if (!conflictRevision) return;
    const current = draftsRef.current.get(requestIdentity);
    if (current) {
      draftsRef.current.set(requestIdentity, { ...current, baseRevision: conflictRevision });
    }
    setConflictDialogOpen(false);
    setAutoSaveState("dirty");
    void saveDraft(conflictRevision);
  }, [conflictRevision, requestIdentity, saveDraft]);

  useEffect(() => {
    if (refreshRequestId === handledRefreshRequestIdRef.current) {
      return;
    }
    handledRefreshRequestIdRef.current = refreshRequestId;
    reloadCurrentFile();
  }, [refreshRequestId, reloadCurrentFile]);

  useEffect(() => {
    if (!fileChanges || !workspaceId || request.type !== "file") {
      return;
    }
    const watchedPath = normalizePreviewEventPath(request.path);
    return fileChanges.subscribeWorkspace(workspaceId, (notification) => {
      if (notification.resyncRequired) {
        reloadCurrentFile();
        return;
      }
      const relevant = notification.changes.filter(
        (change) => normalizePreviewEventPath(change.path) === watchedPath,
      );
      if (!relevant.length) {
        return;
      }
      if (saveInFlightRef.current) {
        return;
      }
      if (relevant.some((change) => change.kind !== "deleted")) {
        if (hasUnsavedChangesRef.current) {
          setConflictDialogOpen(true);
          setConflictRevision(null);
          setAutoSaveState("conflict");
          notifyAutoSaveError("conflict", FILE_SAVE_CONFLICT_MESSAGE);
          reloadCurrentFile();
          return;
        }
        setFileUnavailable(false);
        reloadCurrentFile();
        return;
      }
      setFileUnavailable(true);
      setReloadError("文件已删除，仍显示上次内容；同路径重建后将自动恢复。");
    });
  }, [fileChanges, notifyAutoSaveError, reloadCurrentFile, requestIdentity, workspaceId]);

  useEffect(() => {
    if (!fileChanges || request.type !== "local-file") {
      return;
    }
    const watchId = `file-preview:${stableMarkdownIdentityHash(requestIdentity)}`;
    return fileChanges.subscribeLocalFile(watchId, request.path, (notification) => {
      if (notification.resyncRequired) {
        reloadCurrentFile();
        return;
      }
      if (!notification.changes.length) {
        return;
      }
      if (saveInFlightRef.current) {
        return;
      }
      if (notification.changes.some((change) => change.kind !== "deleted")) {
        if (hasUnsavedChangesRef.current) {
          setConflictDialogOpen(true);
          setConflictRevision(null);
          setAutoSaveState("conflict");
          notifyAutoSaveError("conflict", FILE_SAVE_CONFLICT_MESSAGE);
          reloadCurrentFile();
          return;
        }
        setFileUnavailable(false);
        reloadCurrentFile();
        return;
      }
      setFileUnavailable(true);
      setReloadError("文件已删除，仍显示上次内容；同路径重建后将自动恢复。");
    });
  }, [fileChanges, notifyAutoSaveError, reloadCurrentFile, requestIdentity]);

  useEffect(() => {
    const themeObserver = new MutationObserver(() => setTheme(getTheme()));
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => themeObserver.disconnect();
  }, []);


  useEffect(() => {
    let active = true;
    const identityChanged = requestIdentityRef.current !== requestIdentity;
    requestIdentityRef.current = requestIdentity;
    if (identityChanged) {
      pendingViewModeScrollRestoreRef.current = null;
      setError(null);
      setReloadError(null);
      lastAutoSaveNotificationKeyRef.current = null;
      setAutoSaveState("idle");
      setConflictDialogOpen(false);
      setConflictRevision(null);
      setFileUnavailable(false);
      setMedia(null);
      setDocumentRevision(null);
      resetCopyFeedback();
      setViewMode(defaultViewMode(request));
      setSplitMode(false);
      hasLoadedRef.current = immediatePreviewContent(request) !== null;
    }

    if (request.type === "content" || request.type === "skill-resource") {
      const nextContent = request.content || "";
      setPersistedContent(nextContent);
      draftsRef.current.delete(requestIdentity);
      setContent(nextContent);
      setLoading(false);
      setReloading(false);
      return () => {
        active = false;
      };
    }

    if (request.type === "diff") {
      const nextContent = request.diff || "暂无 diff";
      setPersistedContent(nextContent);
      draftsRef.current.delete(requestIdentity);
      setContent(nextContent);
      setLoading(false);
      setReloading(false);
      return () => {
        active = false;
      };
    }

    if (request.type === "diff-document") {
      const nextContent = diffDocumentRawSource(request) || "暂无 diff";
      setPersistedContent(nextContent);
      draftsRef.current.delete(requestIdentity);
      setContent(nextContent);
      setLoading(false);
      setReloading(false);
      return () => {
        active = false;
      };
    }

    if (identityChanged) {
      setPersistedContent("");
      setContent("");
    }
    if (!runtime || (request.type === "file" && !fileLoadScope)) {
      setError("工作区预览运行时未就绪");
      setLoading(false);
      setReloading(false);
      return () => {
        active = false;
      };
    }

    const preservePrevious = !identityChanged && hasLoadedRef.current;
    if (
      preservePrevious &&
      pendingScrollRestoreRef.current === null &&
      documentViewportRef.current
    ) {
      pendingScrollRestoreRef.current = documentViewportRef.current.scrollTop;
    }
    setError(null);
    setReloadError(null);
    setLoading(!preservePrevious);
    setReloading(preservePrevious);
    const documentReadController = new AbortController();
    const documentReadOptions = {
      consumerId: documentReadConsumerIdRef.current,
      signal: documentReadController.signal,
    };
    const applyDocumentSnapshot = (response: { content: string; revision?: string | null }) => {
      if (!active) return;
      const revision = typeof response.revision === "string" ? response.revision : null;
      const draft = draftsRef.current.get(requestIdentity);
      setPersistedContent(response.content);
      setDocumentRevision(revision);
      if (draft) {
        setContent(draft.content);
        if (revision && draft.baseRevision !== revision) {
          setConflictRevision(revision);
          setConflictDialogOpen(true);
          setAutoSaveState("conflict");
          notifyAutoSaveError("conflict", FILE_SAVE_CONFLICT_MESSAGE);
        } else {
          setAutoSaveState("dirty");
        }
      } else {
        setContent(response.content);
        if (identityChanged) {
          setAutoSaveState("idle");
        }
      }
      hasLoadedRef.current = true;
      setFileUnavailable(false);
    };
    const loader =
      request.type === "local-file"
        ? kind === "image"
          ? runtime.localPreview.readMedia(request.path).then((response) => {
              if (active) {
                setMedia(response);
                hasLoadedRef.current = true;
                setFileUnavailable(false);
              }
            })
          : runtime.localPreview.readDocument(request.path, documentReadOptions).then((response) => {
              applyDocumentSnapshot(response);
            })
        : kind === "image"
          ? runtime.workspace.readMedia(fileLoadScope as WorkspaceScope, request.path).then((response) => {
              if (active) {
                setMedia(response);
                hasLoadedRef.current = true;
                setFileUnavailable(false);
              }
            })
          : (runtime.workspace.readDocument
              ? runtime.workspace.readDocument(
                  fileLoadScope as WorkspaceScope,
                  request.path,
                  documentReadOptions,
                )
              : runtime.workspace.readFile(fileLoadScope as WorkspaceScope, request.path)
            ).then((response) => {
              applyDocumentSnapshot(response);
            });

    void loader
      .catch((reason) => {
        if (active) {
          const message = errorMessage(reason);
          if (preservePrevious) {
            setReloadError(`刷新失败，仍显示上次内容：${message}`);
          } else {
            setError(message);
          }
          markdownRuntimeDiagnostics.record({
            stage: "ingress",
            severity: "fatal",
            code: "document-read-failed",
            documentId: `file-preview:${workspaceId ?? sessionId ?? "local"}:${request.path}`,
            revision: null,
            recovery: "retry",
            detail: reason,
            blockId: null,
            resourceId: null,
          });
        }
      })
      .finally(() => {
        if (active) {
          setLoading(false);
          setReloading(false);
        }
      });

    return () => {
      active = false;
      documentReadController.abort();
      runtime.localPreview?.releaseDocumentConsumer?.(documentReadConsumerIdRef.current);
      runtime.workspace?.releaseDocumentConsumer?.(documentReadConsumerIdRef.current);
    };
  }, [
    fileLoadScope,
    kind,
    notifyAutoSaveError,
    reloadVersion,
    requestIdentity,
    resetCopyFeedback,
    runtime,
  ]);

  useLayoutEffect(() => {
    const scrollTop = pendingScrollRestoreRef.current;
    const viewport = documentViewportRef.current;
    if (scrollTop === null || !viewport) {
      return;
    }
    viewport.scrollTop = scrollTop;
    const frame = window.requestAnimationFrame(() => {
      if (documentViewportRef.current) {
        documentViewportRef.current.scrollTop = scrollTop;
      }
      if (
        kind !== "markdown" ||
        (markdownRuntimeSnapshot && markdownRuntimeSnapshot.revision === documentRevision)
      ) {
        pendingScrollRestoreRef.current = null;
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [documentRevision, kind, markdownRuntimeSnapshot]);

  useEffect(() => {
    if (!usesFileOpenDelay) {
      setFileOpenSettling(false);
      return;
    }
    setFileOpenSettling(true);
    const timer = window.setTimeout(() => {
      setFileOpenSettling(false);
    }, FILE_PREVIEW_OPEN_SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [requestIdentity, usesFileOpenDelay]);

  const title = previewTitle(request);
  const canPreview = kind === "markdown" || kind === "html" || kind === "mermaid" || kind === "diff";
  const canRenderPreview = canPreview;
  const canSplit = kind === "markdown" || kind === "html";
  const sourceLabel = previewSourceLabel(request);
  const formattedSource = previewContent;
  const markdownRuntimeWorkspaceId = workspaceId ?? (sessionId ? `session:${sessionId}` : "local");
  const markdownRuntimePath = revealPath ?? sourceLabel;
  const markdownRuntimeRevision = renderedPreviewRevision;
  const splitViewActive = splitMode && canSplit;
  const primaryHtmlFrameOwnsScroll = kind === "html" && viewMode === "preview" && !splitViewActive;
  const htmlFrameOwnsScroll = kind === "html" && (viewMode === "preview" || splitViewActive);
  const sourcePaneScrollElement = splitViewActive ? splitSourceViewport : documentViewport;
  const previewPaneScrollElement = splitViewActive ? splitPreviewViewport : documentViewport;
  const switchViewMode = useCallback((targetMode: "preview" | "source") => {
    if (targetMode === viewMode && !splitViewActive) return;
    const anchor = kind === "markdown" && !splitViewActive && documentViewport
      ? viewMode === "source"
        ? sourceEditorView
          ? codeMirrorViewportSourceAnchor(sourceEditorView, documentViewport)
          : null
        : markdownRuntimeHostRef.current?.viewportSourceAnchor() ?? null
      : null;
    pendingViewModeScrollRestoreRef.current = anchor
      ? { requestIdentity, targetMode, anchor }
      : null;
    splitScrollOwnerRef.current = targetMode;
    setViewMode(targetMode);
    setSplitMode(false);
  }, [documentViewport, kind, requestIdentity, sourceEditorView, splitViewActive, viewMode]);
  const publishViewportNearBottom = useCallback((nearBottom: boolean) => {
    if (lastViewportNearBottomRef.current === nearBottom) {
      return;
    }
    lastViewportNearBottomRef.current = nearBottom;
    onViewportNearBottomChange?.(nearBottom);
  }, [onViewportNearBottomChange]);

  useEffect(() => {
    lastViewportNearBottomRef.current = null;
    onViewportNearBottomChange?.(false);
  }, [onViewportNearBottomChange, requestIdentity, splitViewActive, viewMode]);

  useEffect(() => {
    if (!onViewportNearBottomChange || !documentViewport || htmlFrameOwnsScroll) {
      return;
    }
    let frame: number | null = null;
    const update = () => {
      frame = null;
      const clientHeight = documentViewport.clientHeight;
      if (clientHeight <= 0) {
        return;
      }
      const threshold = Math.max(
        FILE_PREVIEW_BOTTOM_PROXIMITY_MIN_PX,
        Math.min(FILE_PREVIEW_BOTTOM_PROXIMITY_MAX_PX, clientHeight * 0.12),
      );
      const remaining = documentViewport.scrollHeight - clientHeight - documentViewport.scrollTop;
      publishViewportNearBottom(
        documentViewport.scrollHeight <= clientHeight + 1 || remaining <= threshold,
      );
    };
    const schedule = () => {
      if (frame !== null) {
        return;
      }
      frame = window.requestAnimationFrame(update);
    };
    documentViewport.addEventListener("scroll", schedule, { passive: true });
    const resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    resizeObserver?.observe(documentViewport);
    if (annotationLayoutRef.current) {
      resizeObserver?.observe(annotationLayoutRef.current);
    }
    schedule();
    return () => {
      documentViewport.removeEventListener("scroll", schedule);
      resizeObserver?.disconnect();
      if (frame !== null) {
        window.cancelAnimationFrame(frame);
      }
    };
  }, [documentViewport, htmlFrameOwnsScroll, onViewportNearBottomChange, publishViewportNearBottom]);

  useEffect(() => {
    if (!onViewportNearBottomChange || !htmlFrameOwnsScroll || !htmlFrameElement) {
      return;
    }
    const handleMessage = (event: MessageEvent) => {
      if (event.source !== htmlFrameElement.contentWindow || !isHtmlPreviewViewportMessage(event.data)) {
        return;
      }
      publishViewportNearBottom(event.data.nearBottom);
    };
    window.addEventListener("message", handleMessage);
    return () => {
      window.removeEventListener("message", handleMessage);
    };
  }, [htmlFrameElement, htmlFrameOwnsScroll, onViewportNearBottomChange, publishViewportNearBottom]);

  useLayoutEffect(() => {
    if (!splitViewActive || !documentViewport) return;
    documentViewport.scrollTop = 0;
  }, [documentViewport, splitViewActive]);

  useEffect(() => {
    const pending = pendingViewModeScrollRestoreRef.current;
    if (
      !pending
      || pending.requestIdentity !== requestIdentity
      || pending.targetMode !== viewMode
      || splitViewActive
      || kind !== "markdown"
      || !documentViewport
    ) {
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      const current = pendingViewModeScrollRestoreRef.current;
      if (current !== pending) return;
      const restored = pending.targetMode === "preview"
        ? markdownRuntimeHostRef.current?.syncViewportToSourceAnchor(pending.anchor) === true
        : Boolean(sourceEditorView
          && syncCodeMirrorViewportToSourceAnchor(sourceEditorView, documentViewport, pending.anchor));
      if (restored && pendingViewModeScrollRestoreRef.current === pending) {
        pendingViewModeScrollRestoreRef.current = null;
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [
    documentViewport,
    kind,
    markdownRuntimePublishVersion,
    requestIdentity,
    sourceEditorView,
    splitViewActive,
    viewMode,
  ]);

  useEffect(() => {
    if (!splitViewActive || !splitSourceViewport || !splitPreviewViewport || !sourceEditorView) return;
    let active = true;
    let sourceFrame: number | null = null;
    let previewFrame: number | null = null;
    let sourceReleaseFrame: number | null = null;
    let previewReleaseFrame: number | null = null;
    let suppressSource = false;
    let suppressPreview = false;

    const releaseSourceSuppression = () => {
      if (sourceReleaseFrame !== null) window.cancelAnimationFrame(sourceReleaseFrame);
      sourceReleaseFrame = window.requestAnimationFrame(() => {
        sourceReleaseFrame = window.requestAnimationFrame(() => {
          sourceReleaseFrame = null;
          suppressSource = false;
        });
      });
    };
    const releasePreviewSuppression = () => {
      if (previewReleaseFrame !== null) window.cancelAnimationFrame(previewReleaseFrame);
      previewReleaseFrame = window.requestAnimationFrame(() => {
        previewReleaseFrame = window.requestAnimationFrame(() => {
          previewReleaseFrame = null;
          suppressPreview = false;
        });
      });
    };
    const syncPreviewFromSource = () => {
      sourceFrame = null;
      if (!active || splitScrollOwnerRef.current !== "source") return;
      const sourceAnchor = codeMirrorViewportSourceAnchor(sourceEditorView, splitSourceViewport);
      if (sourceAnchor === null) return;
      suppressPreview = true;
      const handled = kind === "markdown"
        ? markdownRuntimeHostRef.current?.syncViewportToSourceAnchor(sourceAnchor) === true
        : syncScrollProgress(splitSourceViewport, splitPreviewViewport);
      if (handled) releasePreviewSuppression();
      else suppressPreview = false;
    };
    const syncSourceFromPreview = () => {
      previewFrame = null;
      if (!active || splitScrollOwnerRef.current !== "preview") return;
      const sourceAnchor = kind === "markdown"
        ? markdownRuntimeHostRef.current?.viewportSourceAnchor() ?? null
        : null;
      suppressSource = true;
      const handled = sourceAnchor !== null
        ? syncCodeMirrorViewportToSourceAnchor(sourceEditorView, splitSourceViewport, sourceAnchor)
        : syncScrollProgress(splitPreviewViewport, splitSourceViewport);
      if (handled) releaseSourceSuppression();
      else suppressSource = false;
    };
    const handleSourceScroll = () => {
      if (splitScrollOwnerRef.current !== "source" || suppressSource || sourceFrame !== null) return;
      if (previewFrame !== null) {
        window.cancelAnimationFrame(previewFrame);
        previewFrame = null;
      }
      sourceFrame = window.requestAnimationFrame(syncPreviewFromSource);
    };
    const handlePreviewScroll = () => {
      if (splitScrollOwnerRef.current !== "preview" || suppressPreview || previewFrame !== null) return;
      if (sourceFrame !== null) {
        window.cancelAnimationFrame(sourceFrame);
        sourceFrame = null;
      }
      previewFrame = window.requestAnimationFrame(syncSourceFromPreview);
    };
    const markSourceInteraction = () => {
      splitScrollOwnerRef.current = "source";
      suppressSource = false;
    };
    const markPreviewInteraction = () => {
      splitScrollOwnerRef.current = "preview";
      suppressPreview = false;
    };

    splitSourceViewport.addEventListener("scroll", handleSourceScroll, { passive: true });
    splitPreviewViewport.addEventListener("scroll", handlePreviewScroll, { passive: true });
    for (const eventName of ["pointerdown", "wheel", "touchstart", "keydown", "focusin"] as const) {
      splitSourceViewport.addEventListener(eventName, markSourceInteraction, { passive: true });
      splitPreviewViewport.addEventListener(eventName, markPreviewInteraction, { passive: true });
    }
    const initialFrame = window.requestAnimationFrame(() => {
      if (splitScrollOwnerRef.current === "preview") handlePreviewScroll();
      else handleSourceScroll();
    });
    return () => {
      active = false;
      splitSourceViewport.removeEventListener("scroll", handleSourceScroll);
      splitPreviewViewport.removeEventListener("scroll", handlePreviewScroll);
      for (const eventName of ["pointerdown", "wheel", "touchstart", "keydown", "focusin"] as const) {
        splitSourceViewport.removeEventListener(eventName, markSourceInteraction);
        splitPreviewViewport.removeEventListener(eventName, markPreviewInteraction);
      }
      window.cancelAnimationFrame(initialFrame);
      if (sourceFrame !== null) window.cancelAnimationFrame(sourceFrame);
      if (previewFrame !== null) window.cancelAnimationFrame(previewFrame);
      if (sourceReleaseFrame !== null) window.cancelAnimationFrame(sourceReleaseFrame);
      if (previewReleaseFrame !== null) window.cancelAnimationFrame(previewReleaseFrame);
    };
  }, [kind, sourceEditorView, splitPreviewViewport, splitSourceViewport, splitViewActive]);
  const providerMarkdownViewDescriptor = previewContext?.activeEntry?.request === request
    ? previewContext.activeEntry.markdownView
    : null;
  const resolvedMarkdownViewDescriptor = useMemo<PreviewMarkdownViewDescriptor>(() =>
    markdownViewDescriptor ?? providerMarkdownViewDescriptor ?? Object.freeze({
      scopeId: previewContext?.activeScopeKey ?? `workspace:${markdownRuntimeWorkspaceId}`,
      entryId: `standalone:${stableMarkdownIdentityHash(`${markdownRuntimeWorkspaceId}:${markdownRuntimePath}`)}`,
      viewId: standaloneMarkdownViewIdRef.current,
      kind: "preview",
    }), [markdownRuntimePath, markdownRuntimeWorkspaceId, markdownViewDescriptor, previewContext?.activeScopeKey, providerMarkdownViewDescriptor]);
  useEffect(() => {
    setMarkdownRuntimeSnapshot(null);
    setMarkdownRuntimeSource(null);
  }, [kind, markdownRuntimePath]);
  useEffect(() => {
    setMarkdownRuntimeError(null);
    setMarkdownRuntimeFindIndex(null);
    setMarkdownRuntimeSelection(null);
  }, [kind, markdownRuntimePath, markdownRuntimeRevision]);
  const markdownOutline = useMemo(
    () => (markdownRuntimeSnapshot?.outline ?? []).map((item) => ({
      id: item.id,
      level: item.level,
      line: item.source_line,
      title: item.title,
    })),
    [markdownRuntimeSnapshot],
  );
  useEffect(() => {
    if (!onMarkdownOutlineChange) {
      return;
    }
    if (kind !== "markdown") {
      onMarkdownOutlineChange([]);
      return;
    }
    if (previewBusy) {
      return;
    }
    onMarkdownOutlineChange(error ? [] : markdownOutline);
  }, [error, kind, markdownOutline, onMarkdownOutlineChange, previewBusy]);

  const annotationMode = kind === "markdown" ? (splitMode ? "split" : viewMode) : "source";
  const annotationDocumentWorker = useMemo<AnnotationDocumentWorkerResolver | null>(() => {
    if (kind !== "markdown" || effectiveMarkdownRuntimeSnapshotLoader) return null;
    return Object.freeze({
      resolve: (input: AnnotationDocumentWorkerResolveInput) => {
        const host = markdownRuntimeHostRef.current;
        return host
          ? host.resolveAnnotations(input)
          : Promise.reject(new Error("Markdown Document Worker is not ready"));
      },
    });
  }, [effectiveMarkdownRuntimeSnapshotLoader, kind]);
  const annotationSession = useUnifiedAnnotationSession({
    documentWorker: annotationDocumentWorker,
    documentRevision,
    kind,
    markdownModel: markdownRuntimeSnapshot,
    mode: annotationMode,
    path: annotationPath,
    runtime: runtime?.annotations ?? null,
    source: kind === "markdown" && markdownRuntimeSource !== null
      ? markdownRuntimeSource
      : formattedSource,
    workspaceId: workspaceId ?? null,
  });
  const annotationNotificationError = annotationSession.state.error || annotationSession.state.navigation.error;
  useEffect(() => {
    if (annotationNotificationError) {
      notifications.error(annotationNotificationError);
    }
  }, [annotationNotificationError, notifications]);
  const annotationAvailable = annotationSession.available && !fileUnavailable && !hasUnsavedChanges;
  const annotationPanelOpen = annotationSession.state.panelOpen;
  const activeAnnotationId = annotationSession.state.activeAnnotationId;
  const flashAnnotationId = annotationSession.state.flashAnnotationId;
  useLayoutEffect(() => {
    if (!splitViewActive || !annotationPanelOpen || !splitPreviewViewport || !annotationRailElement) {
      return;
    }
    const syncRailScroll = () => {
      annotationRailElement.scrollTop = splitPreviewViewport.scrollTop;
      annotationRailElement.scrollLeft = 0;
    };
    syncRailScroll();
    splitPreviewViewport.addEventListener("scroll", syncRailScroll, { passive: true });
    return () => splitPreviewViewport.removeEventListener("scroll", syncRailScroll);
  }, [annotationPanelOpen, annotationRailElement, splitPreviewViewport, splitViewActive]);
  const closeAnnotationPanel = useCallback(() => annotationSession.store.getState().closePanel(), [annotationSession.store]);
  const toggleAnnotationPanel = useCallback(() => annotationSession.store.getState().togglePanel(), [annotationSession.store]);
  const draftingRange = annotationSession.state.interaction.type === "drafting"
    ? annotationSession.state.interaction.range
    : null;
  const draftPlacement = annotationSession.lanePlacements.find(
    (placement) => placement.id === DRAFT_ANNOTATION_ID,
  ) ?? null;
  const draftAnchorPoint = annotationSession.connectorGeometry
    ? markerAnchorPoint(annotationSession.connectorGeometry, DRAFT_ANNOTATION_ID)
    : null;
  const draftLayoutReady = kind !== "markdown"
    ? draftPlacement !== null
    : Boolean(draftPlacement && draftAnchorPoint
      && Math.abs(draftPlacement.anchorY - draftAnchorPoint.y) < 0.5);
  const railRevealRequest = annotationSession.railRevealRequest;
  const railRevealResolution = railRevealRequest
    ? annotationSession.state.resolutions.byId[railRevealRequest.annotationId]
    : null;
  const railRevealPlacement = railRevealRequest
    ? annotationSession.lanePlacements.find((placement) => placement.id === railRevealRequest.annotationId) ?? null
    : null;
  const railRevealAnchorPoint = railRevealRequest && annotationSession.connectorGeometry
    ? markerAnchorPoint(annotationSession.connectorGeometry, railRevealRequest.annotationId)
    : null;
  const railRevealLayoutReady = railRevealResolution?.status !== "resolved"
    || Boolean(railRevealPlacement && railRevealAnchorPoint
      && Math.abs(railRevealPlacement.anchorY - railRevealAnchorPoint.y) < 0.5);
  useEffect(() => {
    const request = railRevealRequest;
    if (!request || !annotationPanelOpen || !documentViewport
      || activeAnnotationId !== request.annotationId || !railRevealLayoutReady) {
      return;
    }
    const controller = new AbortController();
    const frame = window.requestAnimationFrame(() => {
      const card = Array.from(
        annotationLayoutRef.current?.querySelectorAll<HTMLElement>("[data-annotation-card-id]") ?? [],
      ).find((element) => element.dataset.annotationCardId === request.annotationId);
      if (!card) {
        return;
      }
      if (splitViewActive) {
        restartAnnotationNavigationFlash(card);
        return;
      }
      void centerElementInScrollViewport(documentViewport, card, controller.signal)
        .then(() => restartAnnotationNavigationFlash(card))
        .catch(() => undefined);
    });
    return () => {
      controller.abort();
      window.cancelAnimationFrame(frame);
    };
  }, [
    activeAnnotationId,
    annotationPanelOpen,
    documentViewport,
    railRevealLayoutReady,
    railRevealRequest,
    splitViewActive,
  ]);

  useEffect(() => {
    if (!activeAnnotationId) return;
    const root = previewRootRef.current;
    const ownerDocument = root?.ownerDocument;
    if (!root || !ownerDocument) return;
    const handleDocumentClick = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (target.closest("[data-annotation-id], [data-annotation-card-id], [data-annotation-rail='true']")) return;
      const markdownBlock = target.closest<HTMLElement>("[data-markdown-block-id]");
      if (markdownBlock?.querySelector("[data-markdown-annotation-resource-block='true'][data-annotation-id]")) {
        return;
      }
      annotationSession.deactivate(activeAnnotationId);
      root.querySelectorAll<HTMLElement>("[data-annotation-navigation-flash='true']")
        .forEach((element) => element.removeAttribute("data-annotation-navigation-flash"));
    };
    ownerDocument.addEventListener("click", handleDocumentClick, true);
    return () => ownerDocument.removeEventListener("click", handleDocumentClick, true);
  }, [activeAnnotationId, annotationSession.deactivate]);

  useEffect(() => {
    if (!annotationPanelOpen || !draftingRange || !draftLayoutReady || !documentViewport) return;
    const controller = new AbortController();
    let scrollFrame = 0;
    const focusFrame = window.requestAnimationFrame(() => {
      const editor = annotationLayoutRef.current?.querySelector<HTMLTextAreaElement>(
        "[data-annotation-draft-editor='true']",
      );
      if (!editor) return;
      editor.focus({ preventScroll: true });
      if (splitViewActive) return;
      scrollFrame = window.requestAnimationFrame(() => {
        void centerElementInScrollViewport(documentViewport, editor, controller.signal).catch(() => undefined);
      });
    });
    return () => {
      controller.abort();
      window.cancelAnimationFrame(focusFrame);
      if (scrollFrame) window.cancelAnimationFrame(scrollFrame);
    };
  }, [
    annotationPanelOpen,
    documentViewport,
    draftLayoutReady,
    draftingRange?.end,
    draftingRange?.start,
    splitViewActive,
  ]);

  useEffect(() => {
    if (!annotationPath || fileUnavailable) return;
    return subscribeStartWorkspaceFileAnnotation((detail) => {
      if (detail.path !== annotationPath || detail.workspaceId !== workspaceId) return;
      annotationSession.store.getState().openPanel();
    });
  }, [annotationPath, annotationSession.store, fileUnavailable, workspaceId]);

  const applyResourceAnnotationSelection = useCallback((selection: DocumentSelection | null) => {
    if (!annotationAvailable || !selection) return false;
    const interaction = annotationSession.store.getState().interaction;
    const applied = interaction.type === "retargeting"
      ? annotationSession.setRetargetSelection(selection)
      : annotationSession.beginDraft(selection);
    if (!applied) {
      notifications.warning("当前资源块无法建立批注锚点。");
      return false;
    }
    window.getSelection()?.removeAllRanges();
    return true;
  }, [
    annotationAvailable,
    annotationSession.beginDraft,
    annotationSession.setRetargetSelection,
    annotationSession.store,
    notifications,
  ]);

  const startWholeResourceAnnotation = useCallback(() => {
    const logicalLength = annotationSession.model?.logicalText.length ?? 0;
    if (logicalLength <= 0) return;
    applyResourceAnnotationSelection({
      coordinateSpace: "logical",
      range: { start: 0, end: logicalLength },
    });
  }, [annotationSession.model, applyResourceAnnotationSelection]);
  const applyResourceAnnotationSelectionRef = useRef(applyResourceAnnotationSelection);
  applyResourceAnnotationSelectionRef.current = applyResourceAnnotationSelection;

  const startSelectionAnnotation = useCallback(
    (selectionSnapshot: FilePreviewSelectionSnapshot) => {
      if (!selectionSnapshot.selectedText.trim()) return;
      const interaction = annotationSession.store.getState().interaction;
      const range = selectionSnapshot.selectionRange;
      const sourceSurface = range?.commonAncestorContainer.parentElement?.closest("[aria-label='源码内容']");
      const selection = sourceSurface || viewMode === "source"
        ? annotationSession.sourceAdapter.selection()
        : null;
      const applied = interaction.type === "retargeting"
        ? selection
          ? annotationSession.setRetargetSelection(selection)
          : annotationSession.setRetargetFromRuntimeSelection(markdownRuntimeSelection)
        : selection
          ? annotationSession.beginDraft(selection)
          : annotationSession.beginDraftFromRuntimeSelection(markdownRuntimeSelection);
      if (!applied) {
        notifications.warning("当前选区无法投影到文档文字模型。");
        return;
      }
      window.getSelection()?.removeAllRanges();
    },
    [annotationSession, markdownRuntimeSelection, notifications, viewMode],
  );
  const openRuntimeLinkedPreview = previewContext?.openPreview;
  const markdownRuntimeInteractions = useMemo<MarkdownRendererInteractionHandlers>(() => ({
    onLinkActivate: (event, { href }) => {
      const target = resolveMarkdownLinkTarget(href);
      if (target.kind === "file") {
        event.preventDefault();
        event.stopPropagation();
        const revealTarget = target.line ? { lineStart: target.line, lineEnd: target.line } : null;
        if (request.type === "skill-resource" && !target.absolute) {
          const resourcePath = resolveRelativeFileLinkPath(target.path, request.resourcePath);
          if (!resourcePath || !previewContext || !runtime) return;
          void openSkillResourcePreview({
            preview: previewContext,
            revealTarget,
            runtime,
            scope,
            target: {
              skillName: request.skillName,
              source: request.skillSource,
              resourcePath,
            },
          }).catch((reason) => notifications.error(skillResourcePreviewError(reason)));
          return;
        }
        const linkedRequest = runtimeLinkedFilePreviewRequest(request, target);
        if (!linkedRequest) return;
        openRuntimeLinkedPreview?.(
          linkedRequest,
          undefined,
          revealTarget,
        );
        return;
      }
      if (target.kind === "anchor") {
        event.preventDefault();
        event.stopPropagation();
        const outline = findMarkdownOutlineTarget(
          markdownRuntimeHostRef.current?.currentSnapshot()?.outline ?? [],
          target.fragment,
        );
        if (outline) markdownRuntimeHostRef.current?.revealBlock(outline.block_id, { align: "start", behavior: "smooth" });
        return;
      }
      if (target.kind === "unsafe") {
        event.preventDefault();
        event.stopPropagation();
      }
    },
    onCodeCopy: async ({ code }) => {
      try {
        await copyText(code);
        showCopyFeedback("copied");
      } catch (error) {
        showCopyFeedback("failed");
        throw error;
      }
    },
    onMermaidPreview: ({ code }) => setRuntimeMermaidPreviewCode(code),
    onResourceAnnotate: ({ block }) => applyResourceAnnotationSelectionRef.current({
      coordinateSpace: "logical",
      range: { start: block.logical_start, end: block.logical_end },
    }),
  }), [notifications, openRuntimeLinkedPreview, previewContext, request, runtime, scope, showCopyFeedback]);

  const quotePreviewSelection = useCallback(
    (selectionSnapshot: FilePreviewSelectionSnapshot, comment?: string) => {
      const text = selectionSnapshot.selectedText.trim();
      const model = annotationSession.model;
      if (!text || !annotationPath) return;
      const sourceSelection = annotationSession.sourceAdapter.selection();
      const runtimeRange = markdownRuntimeSelection
        ? { sourceStart: markdownRuntimeSelection.sourceStart, sourceEnd: markdownRuntimeSelection.sourceEnd }
        : null;
      const previewRange = runtimeRange ?? (selectionSnapshot.selectionRange && bodyRef.current
        ? previewSourceRangeFromSelection(selectionSnapshot.selectionRange, bodyRef.current)
        : null);
      const logical = model && sourceSelection
        ? model.projectSelection(sourceSelection)?.logicalRange ?? null
        : model && kind === "markdown" && previewRange
          ? model.projectSelection({
              coordinateSpace: "source",
              range: { start: previewRange.sourceStart, end: previewRange.sourceEnd },
            })?.logicalRange ?? null
          : null;
      const sourceRange = logical && model
        ? model.toSourceRanges(logical)[0] ?? null
        : previewRange
          ? { start: previewRange.sourceStart, end: previewRange.sourceEnd }
          : sourceSelection?.coordinateSpace === "source"
            ? sourceSelection.range
            : null;
      const lineRange = sourceRange ? sourceLineNumbers(formattedSource, sourceRange.start, sourceRange.end) : null;
      onQuoteSelection?.({
        path: annotationPath,
        selectedText: text,
        ...(comment ? { comment } : {}),
        lineStart: lineRange?.lineStart ?? null,
        lineEnd: lineRange?.lineEnd ?? null,
        sourceStart: sourceRange?.start ?? null,
        sourceEnd: sourceRange?.end ?? null,
      });
    },
    [annotationPath, annotationSession.model, annotationSession.sourceAdapter, formattedSource, kind, markdownRuntimeSelection, onQuoteSelection],
  );

  const saveAnnotationComment = useCallback(
    async (annotationId: string, body: string) =>
      Boolean(await annotationSession.actions?.updateBody(annotationId, body)),
    [annotationSession.actions],
  );
  const deleteAnnotation = useCallback(
    async (annotationId: string) => Boolean(await annotationSession.actions?.delete(annotationId)),
    [annotationSession.actions],
  );
  const startChatFromResolution = useCallback(
    (item: { record: { body: string; id: string; document_path: string; target: { type: "document" | "text" }; workspace_id: string } }) => {
      onStartChatFromAnnotation?.({
        annotationId: item.record.id,
        body: item.record.body,
        kind: item.record.target.type,
        path: item.record.document_path,
        workspaceId: item.record.workspace_id,
      });
    },
    [onStartChatFromAnnotation],
  );
  const startChatFromResolutions = useCallback(
    (items: readonly { record: { body: string; id: string; document_path: string; target: { type: "document" | "text" }; workspace_id: string } }[]) => {
      const references = items.map((item) => ({
        annotationId: item.record.id,
        body: item.record.body,
        kind: item.record.target.type,
        path: item.record.document_path,
        workspaceId: item.record.workspace_id,
      }));
      if (references.length) onStartChatFromAnnotation?.(references);
    },
    [onStartChatFromAnnotation],
  );

  useEffect(() => {
    const revealRequest = sourceRevealRequest;
    const annotationId = revealRequest?.annotationId?.trim();
    if (!revealRequest || !annotationId || !revealPath || previewBusy || error || !annotationAvailable) return;
    if (handledAnnotationRevealRequestIdsRef.current.get(revealPath) === revealRequest.requestId) return;
    const state = annotationSession.store.getState();
    if (state.loading) return;
    const resolution = state.resolutions.byId[annotationId];
    if (!resolution) {
      if (!state.error) {
        handledAnnotationRevealRequestIdsRef.current.set(revealPath, revealRequest.requestId);
        notifications.warning("这条批注已不存在，或不属于当前文件。");
      }
      return;
    }
    handledAnnotationRevealRequestIdsRef.current.set(revealPath, revealRequest.requestId);
    state.activate(annotationId, true);
    if (resolution.status === "resolved") {
      annotationSession.navigate(resolution);
      return;
    }
    annotationSession.requestRailReveal(annotationId);
  }, [
    annotationAvailable,
    annotationSession.navigate,
    annotationSession.requestRailReveal,
    annotationSession.state.loading,
    annotationSession.state.resolutions.annotationSetRevision,
    annotationSession.store,
    error,
    notifications,
    previewBusy,
    revealPath,
    sourceRevealRequest,
  ]);

  useEffect(() => {
    if (!sourceRevealRequest || !revealPath || previewBusy || error) return;
    if (sourceRevealRequest.annotationId) return;
    if (handledSourceRevealRequestIdsRef.current.get(revealPath) === sourceRevealRequest.requestId) return;
    const position = sourceRevealRequest.sourceStart
      ?? (sourceRevealRequest.lineStart ? sourcePositionForLine(formattedSource, sourceRevealRequest.lineStart) : null);
    if (position === null) return;
    const runtimePreviewVisible = kind === "markdown" && (viewMode === "preview" || splitMode);
    if (runtimePreviewVisible && !markdownRuntimeSnapshot) return;
    const runtimeRevealHandled = !runtimePreviewVisible
      || (sourceRevealRequest.lineStart
        ? markdownRuntimeHostRef.current?.revealSourceLines(
          sourceRevealRequest.lineStart,
          sourceRevealRequest.lineEnd ?? sourceRevealRequest.lineStart,
          { align: "center", behavior: "auto" },
        )
        : markdownRuntimeHostRef.current?.revealSourceOffset(position, { align: "center", behavior: "auto" }));
    if (!runtimeRevealHandled) return;
    handledSourceRevealRequestIdsRef.current.set(revealPath, sourceRevealRequest.requestId);
    setLineRevealRequest((current) => ({
      requestId: (current?.requestId ?? 0) + 1,
      position,
      block: "center",
    }));
  }, [error, formattedSource, kind, markdownRuntimeSnapshot, previewBusy, revealPath, sourceRevealRequest, splitMode, viewMode]);
  useEffect(() => {
    if (!outlineRevealRequest || kind !== "markdown") {
      return;
    }
    const runtimeOutlineItem = markdownRuntimeSnapshot?.outline.find((item) => item.id === outlineRevealRequest.id) ?? null;
    if (viewMode !== "source" || splitMode) {
      if (!markdownRuntimeSnapshot) return;
      if (runtimeOutlineItem) {
        markdownRuntimeHostRef.current?.revealBlock(runtimeOutlineItem.block_id, { align: "start" });
      }
    }
    if (viewMode === "preview" && !splitMode) {
      return;
    }
    setLineRevealRequest((current) => ({
      requestId: (current?.requestId ?? 0) + 1,
      position: sourcePositionForLine(formattedSource, outlineRevealRequest.line),
    }));
  }, [formattedSource, kind, markdownRuntimeSnapshot, outlineRevealRequest, splitMode, viewMode]);

  const findMode: FilePreviewFindMode = splitMode && canSplit
    ? "split"
    : viewMode === "source" || !canRenderPreview
      ? "source"
      : "preview";
  useEffect(() => {
    if (kind !== "markdown" || !findOpen || !findQuery.trim()
      || (findMode !== "preview" && findMode !== "split") || !markdownRuntimeSnapshot) {
      setMarkdownRuntimeFindIndex((current) => current ? null : current);
      return;
    }
    const controller = new AbortController();
    void markdownRuntimeHostRef.current?.queryFind(findQuery, { signal: controller.signal })
      .then((index) => {
        if (!controller.signal.aborted) setMarkdownRuntimeFindIndex(index);
      })
      .catch((reason) => {
        if (controller.signal.aborted) return;
        markdownRuntimeDiagnostics.record({
          stage: "host",
          severity: "error",
          code: "runtime-find-failed",
          documentId: markdownRuntimeSnapshot.document_id,
          revision: markdownRuntimeSnapshot.revision,
          recovery: "retain-snapshot",
          detail: reason,
          blockId: null,
          resourceId: null,
        });
        setMarkdownRuntimeFindIndex(null);
      });
    return () => controller.abort();
  }, [findMode, findOpen, findQuery, kind, markdownRuntimeSnapshot]);

  const markdownFindMatches = useMemo<MarkdownPreviewFindMatch[]>(
    () =>
      (markdownRuntimeFindIndex?.matches ?? []).map((match) => ({
        blockId: match.blockId,
        id: match.id,
        sourceEnd: match.sourceEnd,
        sourceStart: match.sourceStart,
        type: "markdown",
      })),
    [markdownRuntimeFindIndex],
  );

  const openFind = useCallback(
    (sourceTarget: EventTarget | null) => {
      const root = previewRootRef.current;
      const targetRoot = filePreviewRootForTarget(sourceTarget);
      const shouldOpen = findOpen || targetRoot === root || (!targetRoot && activeFilePreviewRoot === root);
      if (!root || !shouldOpen) {
        return;
      }
      const selectedText = selectedFilePreviewTextForFind(root, sourceSelectionRef.current);
      if (selectedText) {
        setFindQuery(selectedText);
        setFindMatchIndex(-1);
      } else if (!findOpen) {
        setFindQuery("");
        setFindMatchIndex(-1);
      }
      activeFilePreviewRoot = root;
      setFindOpen(true);
      setFindFocusRequestId((current) => current + 1);
    },
    [findOpen],
  );

  const closeFind = useCallback(() => {
    setFindOpen(false);
    setFindQuery("");
    setFindMatchCount(0);
    setFindMatchIndex(-1);
    setActiveMarkdownFindMatchId(null);
    clearDomFindHighlights(bodyRef.current, { includeControlledMarks: true });
  }, []);

  const activateFindRoot = useCallback(() => {
    const root = previewRootRef.current;
    if (root) {
      activeFilePreviewRoot = root;
    }
  }, []);

  const handlePreviewPointerDownCapture = useCallback(() => {
    activateFindRoot();
  }, [activateFindRoot]);

  useEffect(() => {
    const handleSelectAllShortcut = (event: KeyboardEvent) => {
      const root = previewRootRef.current;
      if (!root || activeFilePreviewRoot !== root || !isSelectAllShortcut(event)) {
        return;
      }
      if (!selectPreviewContentForShortcut(event.target, root, bodyRef.current)) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
    };
    window.addEventListener("keydown", handleSelectAllShortcut, true);
    return () => window.removeEventListener("keydown", handleSelectAllShortcut, true);
  }, []);

  const handlePreviewKeyDownCapture = useCallback(
    (event: ReactKeyboardEvent<HTMLElement>) => {
      if (isSaveShortcut(event.nativeEvent) && editable) {
        event.preventDefault();
        event.stopPropagation();
        void saveDraft();
        return;
      }
      if (!isFindShortcutEvent(event.nativeEvent)) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      openFind(event.target);
    },
    [editable, openFind, saveDraft],
  );

  useEffect(() => {
    const handleFindShortcut = (event: Event) => {
      openFind((event as CustomEvent<AppFindShortcutDetail>).detail?.sourceTarget ?? null);
    };
    document.addEventListener(APP_FIND_SHORTCUT_EVENT, handleFindShortcut);
    return () => document.removeEventListener(APP_FIND_SHORTCUT_EVENT, handleFindShortcut);
  }, [openFind]);

  useEffect(() => {
    if (!findOpen) {
      return;
    }
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      closeFind();
    };
    window.addEventListener("keydown", handleEscape, true);
    return () => window.removeEventListener("keydown", handleEscape, true);
  }, [closeFind, findOpen]);

  const updateFindQuery = useCallback((value: string) => {
    setFindQuery(value);
    setFindMatchIndex(-1);
  }, []);

  const stepFindMatch = useCallback(
    (direction: 1 | -1) => {
      setFindMatchIndex((current) => {
        if (findMatchCount <= 0) {
          return -1;
        }
        if (current < 0) {
          return direction > 0 ? 0 : findMatchCount - 1;
        }
        const start = current;
        return (start + direction + findMatchCount) % findMatchCount;
      });
    },
    [findMatchCount],
  );

  useLayoutEffect(() => {
    clearDomFindHighlights(bodyRef.current, {
      includeControlledMarks: kind !== "markdown" || !findOpen || !findQuery.trim(),
    });
    const shouldSearchSource = Boolean(sourceEditorView && (findMode === "source" || findMode === "split"));
    if (!findOpen || !findQuery.trim()) {
      sourceEditorView?.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: "" })) });
      setSourceFindState((current) => (current ? null : current));
      setFindMatchCount(0);
      setFindMatchIndex(-1);
      setActiveMarkdownFindMatchId(null);
      lastFindScrollLineRef.current = null;
      return;
    }
    if (!shouldSearchSource) {
      sourceEditorView?.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: "" })) });
      setSourceFindState((current) => (current ? null : current));
    }
    const query = new SearchQuery({ search: findQuery, caseSensitive: false, literal: true });
    const codeMirrorMatches =
      sourceEditorView && shouldSearchSource
        ? collectCodeMirrorFindMatches(sourceEditorView, query)
        : [];
    const domMatches = kind !== "markdown"
      ? collectDomFindMatches(filePreviewFindContainers(bodyRef.current, findMode, Boolean(sourceEditorView)), findQuery)
      : [];
    const matches = mergeFilePreviewFindMatches(findMode, codeMirrorMatches, markdownFindMatches, domMatches);
    const nextIndex = preferredFindMatchIndex(findMatchIndex, matches, bodyRef.current, sourceEditorView);
    setFindMatchCount(matches.length);
    if (nextIndex !== findMatchIndex) {
      setFindMatchIndex(nextIndex);
    }
    const activeMatch = matches[nextIndex] ?? null;
    const activeScrollLine = findMatchScrollLine(activeMatch, {
      findMode,
      query: findQuery,
      source: renderedPreviewContent,
      sourceEditorView,
    });
    const shouldRecenterActiveMatch = !sameFindScrollLine(lastFindScrollLineRef.current, activeScrollLine);
    lastFindScrollLineRef.current = activeScrollLine;
    setActiveMarkdownFindMatchId(activeMarkdownFindMatch(activeMatch)?.id ?? null);
    applyDomFindHighlights(domMatches, activeMatch?.type === "dom" ? activeMatch.id : null);
    if (sourceEditorView && (findMode === "source" || findMode === "split")) {
      const activeCodeMirrorMatch = activeCodeMirrorFindMatch(activeMatch);
      const nextSourceFindState: CodeMirrorFindState = {
        query: findQuery,
        activeFrom: activeCodeMirrorMatch?.from ?? null,
        activeTo: activeCodeMirrorMatch?.to ?? null,
      };
      setSourceFindState((current) =>
        sameCodeMirrorFindState(current, nextSourceFindState) ? current : nextSourceFindState,
      );
      sourceEditorView.dispatch({
        effects: [
          setSearchQuery.of(new SearchQuery({ search: "" })),
          ...(activeCodeMirrorMatch && shouldRecenterActiveMatch
            ? [
                EditorView.scrollIntoView(
                  EditorSelection.range(activeCodeMirrorMatch.from, activeCodeMirrorMatch.to),
                  { y: "center", yMargin: 0 },
                ),
              ]
            : []),
        ],
        selection: activeCodeMirrorMatch
          ? EditorSelection.range(activeCodeMirrorMatch.from, activeCodeMirrorMatch.to)
          : undefined,
      });
      if (activeCodeMirrorMatch && shouldRecenterActiveMatch) {
        smoothScrollCodeMirrorPositionIntoView(
          sourceEditorView,
          activeCodeMirrorMatch.from,
          "center",
          sourcePaneScrollElement,
        );
      }
    }
    if (shouldRecenterActiveMatch) {
      scrollFindMatchIntoView(activeMatch, markdownRuntimeHostRef.current);
    }
  }, [
    findMatchIndex,
    findMode,
    findOpen,
    findQuery,
    kind,
    markdownFindMatches,
    renderedPreviewContent,
    sourcePaneScrollElement,
    sourceEditorView,
  ]);

  useEffect(() => () => clearDomFindHighlights(bodyRef.current, { includeControlledMarks: true }), []);

  const wholeResourceAnnotationState = useMemo<ResourceAnnotationVisualState>(() => {
    const logicalLength = annotationSession.model?.logicalText.length ?? 0;
    if (logicalLength <= 0) return EMPTY_RESOURCE_ANNOTATION_VISUAL_STATE;
    const ids = annotationSession.renderState.markers
      .filter((marker) => marker.logicalRange.start === 0 && marker.logicalRange.end === logicalLength)
      .map((marker) => marker.annotationId);
    if (!ids.length) return EMPTY_RESOURCE_ANNOTATION_VISUAL_STATE;
    return Object.freeze({
      active: Boolean(annotationSession.renderState.activeAnnotationId
        && ids.includes(annotationSession.renderState.activeAnnotationId)),
      highlighted: true,
      hovered: Boolean(annotationSession.renderState.hoveredAnnotationId
        && ids.includes(annotationSession.renderState.hoveredAnnotationId)),
    });
  }, [annotationSession.model?.logicalText.length, annotationSession.renderState]);

  const renderSourcePane = () => (
    <SourceViewer
      content={formattedSource}
      editable={editable && !fileUnavailable}
      kind={kind}
      language={sourceLanguage(request, kind)}
      theme={theme}
      annotationAdapter={annotationSession.sourceAdapter}
      revealLineRequest={lineRevealRequest}
      onEditorViewChange={setSourceEditorView}
      onSourceBlur={() => void saveDraft()}
      onSourceChange={updateDraftContent}
      sourceFindState={sourceFindState}
      onSelectionChange={updateSourceSelection}
      scrollElement={sourcePaneScrollElement}
    />
  );

  const renderPreviewPane = () => {
    if (kind === "mermaid") {
      return (
        <NativeMermaidPreview
          annotationState={wholeResourceAnnotationState}
          code={renderedPreviewContent || ""}
          onAnnotateResource={annotationAvailable ? startWholeResourceAnnotation : undefined}
          selectable
        />
      );
    }

    if (kind === "markdown") {
      return (
        <PreviewScrollPane
          className={styles.markdownPane}
          data-file-markdown-engine="runtime"
          data-file-preview-selectable-content="preview"
          scrollElement={previewPaneScrollElement}
        >
          {(scrollElement) => scrollElement ? (
            <FileMarkdownRuntimeHost
                activeFindMatchId={activeMarkdownFindMatchId}
                annotationPanelOpen={annotationPanelOpen}
                annotationRenderState={annotationSession.renderState}
                bindAnnotation={annotationSession.bindMarkdown}
                findIndex={markdownRuntimeFindIndex}
                interactions={markdownRuntimeInteractions}
                ref={markdownRuntimeHostRef}
                path={markdownRuntimePath}
                revision={markdownRuntimeRevision}
                runtime={runtime}
                scrollElement={scrollElement}
                snapshotLoader={effectiveMarkdownRuntimeSnapshotLoader}
                source={renderedPreviewContent}
                workspaceId={markdownRuntimeWorkspaceId}
                workspaceScope={scope}
                viewDescriptor={resolvedMarkdownViewDescriptor}
                onError={setMarkdownRuntimeError}
                onAnnotationActivate={(annotationId) => annotationSession.markdownAdapter.activateMarker(annotationId)}
                onAnnotationHover={(annotationId) => annotationSession.store.getState().hover(annotationId)}
                onMountedBlocksChange={annotationSession.notifyMarkdownLayoutChange}
                onSelectionChange={(selection) => {
                  setMarkdownRuntimeSelection(selection);
                  annotationSession.markdownAdapter.updateSelection(selection?.annotationSelection ?? null);
                }}
                onSnapshot={publishMarkdownRuntimeSnapshot}
            />
          ) : null}
        </PreviewScrollPane>
      );
    }

    if (kind === "html") {
      const htmlDocument = renderedPreviewContent || "<p>文件为空</p>";
      if (directHtmlPreviewUrl) {
        return (
          <PreviewScrollPane
            className={styles.htmlPane}
            data-html-frame-scroll-owner="true"
            data-file-preview-selectable-content="preview"
            data-resource-annotation-active={wholeResourceAnnotationState.active ? "true" : undefined}
            data-resource-annotation-highlight={wholeResourceAnnotationState.highlighted ? "true" : undefined}
            data-resource-annotation-hovered={wholeResourceAnnotationState.hovered ? "true" : undefined}
            scrollElement={previewPaneScrollElement}
          >
            {annotationAvailable ? (
              <ResourceAnnotationButton label="批注整个 HTML 预览" onClick={startWholeResourceAnnotation} />
            ) : null}
            <iframe
              key={`${directHtmlPreviewUrl}:${hashText(htmlDocument)}`}
              className={styles.htmlFrame}
              ref={setHtmlFrameElement}
              title="HTML 文件预览"
              src={directHtmlPreviewUrl}
            />
          </PreviewScrollPane>
        );
      }
      const htmlFrameSource = resolveHtmlPreviewFrameSource(htmlDocument, {
        sourcePath: request.type === "file" || request.type === "local-file"
          ? request.path
          : request.type === "content"
            ? request.sourcePath
            : undefined,
      });
      return (
        <PreviewScrollPane
          className={styles.htmlPane}
          data-html-frame-scroll-owner="true"
          data-file-preview-selectable-content="preview"
          data-resource-annotation-active={wholeResourceAnnotationState.active ? "true" : undefined}
          data-resource-annotation-highlight={wholeResourceAnnotationState.highlighted ? "true" : undefined}
          data-resource-annotation-hovered={wholeResourceAnnotationState.hovered ? "true" : undefined}
          scrollElement={previewPaneScrollElement}
        >
          {annotationAvailable ? (
            <ResourceAnnotationButton label="批注整个 HTML 预览" onClick={startWholeResourceAnnotation} />
          ) : null}
          <iframe
            key={hashText(htmlDocument)}
            className={styles.htmlFrame}
            ref={setHtmlFrameElement}
            title="HTML 文件预览"
            sandbox={htmlFrameSource.sandbox}
            src={htmlFrameSource.kind === "url" ? htmlFrameSource.src : undefined}
            srcDoc={htmlFrameSource.kind === "srcdoc" ? htmlFrameSource.srcDoc : undefined}
          />
        </PreviewScrollPane>
      );
    }

    if (kind === "diff") {
      if (renderedDiffRequest) {
        return (
          <PreviewDiffView
            document={renderedDiffRequest.document}
            scrollScopeKey={requestIdentity}
            actions={{
              copyPatch: async (patch) => {
                if (!navigator.clipboard?.writeText) throw new Error("剪贴板不可用");
                await navigator.clipboard.writeText(patch);
              },
            }}
          />
        );
      }
      return null;
    }

    return renderSourcePane();
  };

  const renderBodyContent = () => {
    if (kind === "image") {
      return <ImagePreview media={media} title={title} sourceLabel={sourceLabel} />;
    }

    if (splitMode && canSplit) {
      return (
        <div className={styles.splitPane} data-testid="preview-split-pane">
          <section className={styles.splitPanel} aria-label="源码内容">
            <div className={styles.splitPanelHeader}>
              <Code2 size={13} />
              <span>源码</span>
            </div>
            <div className={styles.splitPanelBody}>
              <div
                ref={setSplitSourceViewport}
                className={styles.splitScrollViewport}
                data-split-scroll-pane="source"
              >
                {renderSourcePane()}
                <FilePreviewBottomScrollSpace scrollElement={splitSourceViewport} />
              </div>
            </div>
          </section>
          <section className={styles.splitPanel} aria-label="渲染预览">
            <div className={styles.splitPanelHeader}>
              <Eye size={13} />
              <span>预览</span>
            </div>
            <div className={styles.splitPanelBody}>
              <div
                ref={setSplitPreviewViewport}
                className={styles.splitScrollViewport}
                data-scroll-owner={kind === "html" ? "html-frame" : undefined}
                data-split-scroll-pane="preview"
              >
                {renderPreviewPane()}
              </div>
            </div>
          </section>
        </div>
      );
    }

    if (viewMode === "preview" && canRenderPreview) {
      return renderPreviewPane();
    }

    return renderSourcePane();
  };

  const renderActions = () => (
    <div className={styles.actions}>
      {canPreview ? (
        <div className={styles.segmented} aria-label="预览模式">
          <button
            type="button"
            aria-pressed={viewMode === "preview" && !splitMode}
            onClick={() => switchViewMode("preview")}
          >
            <Eye size={13} />
            <span>预览</span>
          </button>
          <button
            type="button"
            aria-pressed={viewMode === "source" && !splitMode}
            onClick={() => switchViewMode("source")}
          >
            <Code2 size={13} />
            <span>源码</span>
          </button>
          {canSplit ? (
            <button
              type="button"
              aria-pressed={splitMode}
              title="分屏预览"
              onClick={() => {
                if (!splitMode) {
                  splitScrollOwnerRef.current = viewMode === "source" ? "source" : "preview";
                }
                setViewMode("preview");
                setSplitMode((current) => !current);
              }}
            >
              <Columns2 size={13} />
              <span>分屏</span>
            </button>
          ) : null}
        </div>
      ) : null}
      <button
        className={styles.iconButton}
        type="button"
        aria-label="搜索文件内容"
        title="搜索文件内容"
        disabled={previewLoading || Boolean(error) || kind === "image"}
        onClick={() => openFind(previewRootRef.current)}
      >
        <Search size={14} />
      </button>
      {annotationPath ? (
        <button
          className={styles.annotationToggle}
          type="button"
          data-file-preview-selection-excluded="true"
          aria-label={`文件批注 ${annotationSession.state.records.length}`}
          aria-pressed={annotationPanelOpen}
          title="文件批注"
          onClick={toggleAnnotationPanel}
        >
          <MessageSquareText size={13} />
          <span>批注</span>
          <span className={styles.annotationToggleCount}>{annotationSession.state.records.length}</span>
        </button>
      ) : null}
      <button
        className={styles.iconButton}
        type="button"
        aria-label="复制预览内容"
        disabled={previewLoading || Boolean(error) || !previewContent}
        onClick={handleCopy}
      >
        {copyState === "copied" ? <Check size={14} /> : <Copy size={14} />}
      </button>
      {onClose ? (
        <button
          className={styles.iconButton}
          type="button"
          aria-label="关闭文件预览"
          title="关闭文件预览"
          onClick={onClose}
        >
          <X size={14} />
        </button>
      ) : null}
    </div>
  );

  const handleCopy = async () => {
    try {
      await copyText(previewContent);
      showCopyFeedback("copied");
    } catch {
      showCopyFeedback("failed");
    }
  };
  return (
    <section
      className={styles.preview}
      data-chrome={chrome}
      data-file-preview-root="true"
      data-preview-source={request.type}
      data-skill-source={request.type === "skill-resource" ? request.skillSource : undefined}
      data-file-preview-auto-save-state={editable ? autoSaveState : undefined}
      data-file-preview-reloading={reloading ? "true" : "false"}
      data-file-preview-unavailable={fileUnavailable ? "true" : "false"}
      data-file-preview-new-annotations-enabled={annotationAvailable ? "true" : "false"}
      data-file-preview-file-allows-annotations={request.type === "skill-resource" || fileUnavailable ? "false" : "true"}
      data-document-revision={documentRevision ?? undefined}
      data-file-markdown-runtime-mode={kind === "markdown" ? "runtime" : undefined}
      data-file-markdown-runtime-error={markdownRuntimeError ? "true" : undefined}
      data-file-markdown-runtime-selection={markdownRuntimeSelection ? "true" : "false"}
      data-file-annotation-model-ready={annotationSession.model ? "true" : "false"}
      data-file-markdown-view-id={kind === "markdown" ? resolvedMarkdownViewDescriptor.viewId : undefined}
      aria-label="文件预览"
      ref={previewRootRef}
      onKeyDownCapture={handlePreviewKeyDownCapture}
      onFocusCapture={activateFindRoot}
      onMouseDownCapture={activateFindRoot}
      onPointerDownCapture={handlePreviewPointerDownCapture}
      onMouseEnter={activateFindRoot}
    >
      {showPreviewTabs && !panelChrome ? (
        <div className={styles.tabs} role="tablist" aria-label="预览历史">
          {previewEntries.map((entry) => {
            const active = entry.id === activePreviewId;
            return (
              <div key={entry.id} className={styles.tab} data-active={active ? "true" : "false"}>
                <button
                  className={styles.tabMain}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  title={entry.sourceLabel}
                  onClick={() => previewContext?.switchPreview(entry.id)}
                >
                  <span className={styles.tabTitle}>{entry.title}</span>
                </button>
                <button
                  className={styles.tabClose}
                  type="button"
                  aria-label={`关闭预览 ${entry.title}`}
                  title={`关闭预览 ${entry.title}`}
                  onClick={() => previewContext?.closePreviewEntry(entry.id)}
                >
                  <X size={12} />
                </button>
              </div>
            );
          })}
        </div>
      ) : null}
      <header
        className={styles.header}
        data-chrome={chrome}
        data-breadcrumbs-hidden={hideBreadcrumbs ? "true" : "false"}
      >
        {!hideBreadcrumbs ? (
          <div className={styles.breadcrumbGroup}>
            <PathBreadcrumbs path={sourceLabel} rootLabel={breadcrumbRootLabel} />
          </div>
        ) : null}
      {reloading ? (
          <span className={styles.reloadStatus} role="status">正在刷新，当前仍显示上次内容</span>
      ) : null}
        {reloadError ? (
          <span className={styles.reloadError} role="alert">{reloadError}</span>
        ) : null}
        {renderActions()}
      </header>

      {previewBusy ? <FilePreviewLoading label="正在读取文件" /> : null}
      {error || directHtmlPreviewError ? (
        <div className={styles.error} role="alert">{error ?? directHtmlPreviewError}</div>
      ) : null}
      {conflictDialogOpen ? (
        <AppDialog
          title="文件保存冲突"
          description="磁盘文件在你编辑期间发生了变化。当前草稿没有丢失，自动保存已暂停。"
          size="confirm"
          backdrop="preview"
          closeLabel="继续保留草稿"
          onClose={() => setConflictDialogOpen(false)}
          footer={(
            <div className={styles.saveConflictActions}>
              <button type="button" onClick={() => setConflictDialogOpen(false)}>继续保留草稿</button>
              <button type="button" onClick={discardDraftAndReload}>加载磁盘版本</button>
              <button
                type="button"
                data-primary="true"
                disabled={!conflictRevision}
                onClick={overwriteConflictingDocument}
              >
                覆盖磁盘版本
              </button>
            </div>
          )}
        >
          <p className={styles.saveConflictMessage}>{FILE_SAVE_CONFLICT_MESSAGE}</p>
        </AppDialog>
      ) : null}
      {!previewBusy && !error && !directHtmlPreviewError ? (
        <div className={styles.documentViewportShell}>
          {findOpen ? (
            <FilePreviewFindBar
              inputRef={findInputRef}
              query={findQuery}
              matchCount={findMatchCount}
              matchIndex={findMatchIndex}
              focusRequestId={findFocusRequestId}
              onClose={closeFind}
              onQueryChange={updateFindQuery}
              onStep={stepFindMatch}
            />
          ) : null}
          <div
            ref={setDocumentViewportElement}
            className={styles.body}
            data-annotation-rail-open={annotationPanelOpen ? "true" : "false"}
            data-chrome={chrome}
            data-custom-scrollbar="true"
            data-document-scroll-viewport="true"
            data-scroll-owner={primaryHtmlFrameOwnsScroll ? "html-frame" : undefined}
            data-split-mode={splitViewActive ? "true" : undefined}
            data-workspace-document-context={isPathPreviewRequest(request) ? "true" : undefined}
            data-workspace-document-name={isPathPreviewRequest(request) ? fileName(request.path) : undefined}
            data-workspace-document-path={isPathPreviewRequest(request) ? request.path : undefined}
            data-workspace-id={workspaceId}
            data-workspace-session-id={sessionId}
          aria-label="预览内容"
        >
          <div
            ref={annotationLayoutRef}
            className={styles.documentCanvas}
            data-annotation-rail-open={annotationPanelOpen ? "true" : "false"}
          >
            <div className={styles.documentColumn} ref={bodyRef}>
              {renderBodyContent()}
              {!splitViewActive && !primaryHtmlFrameOwnsScroll && !(kind === "markdown" && viewMode === "preview") ? (
                <FilePreviewBottomScrollSpace scrollElement={documentViewport} />
              ) : null}
              {quoteSelectionAvailable || annotationAvailable ? (
                <FilePreviewSelectionLayer
                  bodyRef={bodyRef}
                  enabled={kind !== "image" && !previewBusy && !error}
                  quoteSelectionAvailable={quoteSelectionAvailable}
                  annotationAvailable={annotationAvailable}
                  onQuote={quotePreviewSelection}
                  onAnnotate={startSelectionAnnotation}
                />
              ) : null}
            </div>
            <UnifiedAnnotationConnectors
              layoutRef={annotationLayoutRef}
              open={annotationPanelOpen}
              session={annotationSession}
              splitViewport={splitViewActive ? splitPreviewViewport : null}
            />
              <aside
              aria-label="批注栏"
              className={styles.annotationRail}
              data-annotation-rail="true"
              data-split-mode={splitViewActive ? "true" : undefined}
              hidden={!annotationPanelOpen}
              ref={setAnnotationRailElement}
              style={{
                "--annotation-bottom-actions-reserved": `${ANNOTATION_BOTTOM_ACTIONS_RESERVED}px`,
                "--annotation-card-inline-inset": `${ANNOTATION_RAIL_CARD_INSET}px`,
              } as CSSProperties}
            >
              {annotationPath && annotationPanelOpen ? (
                <UnifiedAnnotationRailContent
                  actionsHost={annotationActionsHost}
                  canCreateDocument={annotationAvailable}
                  canStartChat={Boolean(onStartChatFromAnnotation)}
                  onClose={closeAnnotationPanel}
                  onDelete={deleteAnnotation}
                  onSave={saveAnnotationComment}
                  onStartChat={startChatFromResolution}
                  onStartChatMany={startChatFromResolutions}
                  session={annotationSession}
                />
              ) : null}
            </aside>
          </div>
          </div>
          {annotationPanelOpen ? (
            <div
              aria-label="批注操作"
              className={styles.annotationBottomActionsHost}
              data-annotation-bottom-actions="true"
              ref={setAnnotationActionsHost}
            />
          ) : null}
          {!splitViewActive && !primaryHtmlFrameOwnsScroll ? (
            <FilePreviewScrollRail
              observeSelector={`.${styles.documentCanvas}`}
              railTestId="preview-scroll-rail"
              scrollElement={documentViewport}
              surface="preview"
              thumbTestId="preview-scroll-thumb"
            />
          ) : null}
        </div>
      ) : null}
      {copyState === "failed" && !panelChrome ? <span className={styles.copyError}>复制失败</span> : null}
      {copyState === "copied" && !panelChrome ? <span className={styles.copyHint}>已复制</span> : null}
      {runtimeMermaidPreviewCode !== null ? (
        <FilePreviewFullscreenDialog title="Mermaid 预览" onClose={() => setRuntimeMermaidPreviewCode(null)}>
          <NativeMermaidPreview code={runtimeMermaidPreviewCode} layout="fullscreen" />
        </FilePreviewFullscreenDialog>
      ) : null}
    </section>
  );
}

function UnifiedAnnotationRailContent({
  actionsHost,
  canCreateDocument,
  canStartChat,
  onClose,
  onDelete,
  onSave,
  onStartChat,
  onStartChatMany,
  session,
}: {
  actionsHost: HTMLElement | null;
  canCreateDocument: boolean;
  canStartChat: boolean;
  onClose(): void;
  onDelete(annotationId: string): Promise<boolean>;
  onSave(annotationId: string, body: string): Promise<boolean>;
  onStartChat(item: any): void;
  onStartChatMany(items: readonly any[]): void;
  session: UnifiedAnnotationSession;
}) {
  const [documentDraft, setDocumentDraft] = useState("");
  const [documentComposerOpen, setDocumentComposerOpen] = useState(false);
  const [documentSectionCollapsed, setDocumentSectionCollapsed] = useState(false);
  const state = session.state;
  useEffect(() => {
    const annotationId = session.railRevealRequest?.annotationId;
    if (annotationId && state.resolutions.document.some((item) => item.record.id === annotationId)) {
      setDocumentSectionCollapsed(false);
    }
  }, [session.railRevealRequest, state.resolutions.document]);
  const interaction = state.interaction;
  const retargetRecord = interaction.type === "retargeting"
    ? state.records.find((record) => record.id === interaction.annotationId) ?? null
    : null;
  const unresolved = [...state.resolutions.ambiguous, ...state.resolutions.changed]
    .filter((item) => item.record.id !== retargetRecord?.id);
  const geometryHeight = session.connectorGeometry?.documentHeight ?? 0;
  const documentHeight = Math.max(geometryHeight, 600);
  const documentSectionReserved = state.resolutions.document.length === 0
    ? 0
    : documentSectionCollapsed
      ? 52
      : state.resolutions.document.length * 132;
  const reservedTop = 64 + documentSectionReserved + (documentComposerOpen ? 160 : 0);
  const pending = Boolean(state.pendingMutation);
  const createDocument = async () => {
    const body = documentDraft.trim();
    if (!canCreateDocument || !body || !session.actions) return;
    const created = await session.actions.createDocument(body);
    if (created) {
      setDocumentDraft("");
      setDocumentComposerOpen(false);
    }
  };
  const top = (
    <>
      <DocumentAnnotationSection
        collapsed={documentSectionCollapsed}
        items={state.resolutions.document}
        onCollapsedChange={setDocumentSectionCollapsed}
        onDelete={onDelete}
        onSave={onSave}
        onStartChat={canStartChat ? onStartChat : undefined}
      />
      {documentComposerOpen ? (
        <div className={styles.documentAnnotationComposer}>
          <div className={styles.documentAnnotationComposerHeader}>
            <strong>新建全文批注</strong>
            <span>适用于整份文档</span>
          </div>
          <textarea aria-label="全文批注内容" autoFocus disabled={pending || !canCreateDocument} onChange={(event) => setDocumentDraft(event.target.value)} placeholder="写下针对整份文档的批注…" value={documentDraft} />
          <div className={styles.documentAnnotationComposerActions}>
            <button onClick={() => { setDocumentDraft(""); setDocumentComposerOpen(false); }} type="button">取消</button>
            <button className={styles.documentAnnotationComposerPrimary} disabled={pending || !canCreateDocument || !documentDraft.trim()} onClick={() => void createDocument()} type="button">保存全文批注</button>
          </div>
        </div>
      ) : null}
    </>
  );
  const retargetCard = retargetRecord && interaction.type === "retargeting" ? (
    <AnnotationRetargetCard
      annotation={retargetRecord}
      error={state.error}
      range={interaction.range}
      selector={interaction.selector}
      onCancel={() => session.store.getState().cancelInteraction()}
      onConfirm={session.submitRetarget}
    />
  ) : null;
  const footer = (
    <>
      <AnnotationStatusSection
        items={unresolved}
        onDelete={onDelete}
        onRetarget={(annotationId) => session.store.getState().beginRetarget(annotationId)}
      />
      {retargetCard && session.retargetAnchorY === null ? retargetCard : null}
    </>
  );
  const chatItems = [...state.resolutions.document, ...state.resolutions.resolved];
  const bottomActions = actionsHost ? createPortal(
    <>
      <button
        aria-label="全部引入对话"
        disabled={!canStartChat || chatItems.length === 0}
        onClick={() => onStartChatMany(chatItems)}
        type="button"
      >
        <MessageSquareText size={15} />
        <span>全部引入对话</span>
      </button>
      <button
        aria-label="新增文档批注"
        aria-pressed={documentComposerOpen}
        disabled={!canCreateDocument}
        onClick={() => setDocumentComposerOpen((open) => !open)}
        type="button"
      >
        <MessageSquarePlus size={15} />
        <span>新增文档批注</span>
      </button>
    </>,
    actionsHost,
  ) : null;
  return (
    <>
      <AnnotationRail
      activeAnnotationId={state.activeAnnotationId}
      bottomPadding={ANNOTATION_BOTTOM_ACTIONS_RESERVED}
      documentHeight={documentHeight}
      draft={interaction.type === "drafting" && session.draftAnchorY !== null ? {
        anchorY: session.draftAnchorY,
        body: interaction.body,
        error: state.error,
        onBodyChange: (body) => session.store.getState().updateInteractionBody(body),
        onCancel: () => session.store.getState().cancelInteraction(),
        onSubmit: () => void session.submitDraft(),
        pending,
        revision: session.model?.revision.textRevision ?? "",
      } : null}
      footer={footer}
      floatingItems={retargetCard && session.retargetAnchorY !== null ? [{
        anchorY: session.retargetAnchorY,
        content: retargetCard,
        estimatedHeight: 168,
        id: RETARGET_ANNOTATION_ID,
      }] : EMPTY_ANNOTATION_FLOATING_ITEMS}
      items={session.railItems}
      hoveredAnnotationId={state.hoveredAnnotationId}
      onClose={onClose}
      onDelete={onDelete}
      onLayout={session.setLanePlacements}
      onHoverChange={(annotationId) => session.store.getState().hover(annotationId)}
      onNavigate={session.navigate}
      onSave={onSave}
      onStartChat={canStartChat ? onStartChat : undefined}
      reservedTop={reservedTop}
      top={top}
      totalCount={state.records.length}
      />
      {bottomActions}
    </>
  );
}

function UnifiedAnnotationConnectors({
  layoutRef,
  open,
  session,
  splitViewport,
}: {
  layoutRef: RefObject<HTMLDivElement | null>;
  open: boolean;
  session: UnifiedAnnotationSession;
  splitViewport: HTMLElement | null;
}) {
  const [size, setSize] = useState({
    cardOffsetY: 0,
    documentWidth: 0,
    height: 0,
    markerOffsetX: 0,
    markerOffsetY: 0,
    width: 0,
  });
  useLayoutEffect(() => {
    if (!open) {
      return;
    }
    const layout = layoutRef.current;
    if (!layout) return;
    const documentColumn = layout.querySelector<HTMLElement>(`.${styles.documentColumn}`);
    const update = () => {
      const layoutRect = layout.getBoundingClientRect();
      const splitRect = splitViewport?.getBoundingClientRect() ?? null;
      const next = {
        cardOffsetY: splitViewport ? -splitViewport.scrollTop : 0,
        documentWidth: documentColumn?.clientWidth ?? 0,
        height: splitViewport ? layout.clientHeight : layout.scrollHeight,
        markerOffsetX: splitRect && splitViewport
          ? splitRect.left - layoutRect.left - splitViewport.scrollLeft
          : 0,
        markerOffsetY: splitRect && splitViewport
          ? splitRect.top - layoutRect.top - splitViewport.scrollTop
          : 0,
        width: layout.clientWidth,
      };
      setSize((current) => current.documentWidth === next.documentWidth
        && current.height === next.height
        && current.cardOffsetY === next.cardOffsetY
        && current.markerOffsetX === next.markerOffsetX
        && current.markerOffsetY === next.markerOffsetY
        && current.width === next.width
        ? current
        : next);
    };
    update();
    splitViewport?.addEventListener("scroll", update, { passive: true });
    if (typeof ResizeObserver === "undefined") {
      return () => splitViewport?.removeEventListener("scroll", update);
    }
    const observer = new ResizeObserver(update);
    observer.observe(layout);
    if (documentColumn) {
      observer.observe(documentColumn);
    }
    if (splitViewport) {
      observer.observe(splitViewport);
    }
    const railContent = layout.querySelector<HTMLElement>("[data-annotation-rail-content='true']");
    if (railContent) {
      observer.observe(railContent);
    }
    return () => {
      observer.disconnect();
      splitViewport?.removeEventListener("scroll", update);
    };
  }, [layoutRef, open, splitViewport]);
  const snapshot = session.connectorGeometry;
  const placementById = new Map(session.lanePlacements.map((placement) => [placement.id, placement]));
  const routes = snapshot ? Object.entries(snapshot.markers).flatMap(([annotationId, fragments]) => {
    const placement = placementById.get(annotationId);
    if (!placement || fragments.length === 0) return [];
    const renderedFragments = splitViewport
      ? fragments.map((fragment) => ({
        bottom: fragment.bottom + size.markerOffsetY,
        left: fragment.left + size.markerOffsetX,
        right: fragment.right + size.markerOffsetX,
        top: fragment.top + size.markerOffsetY,
      }))
      : fragments;
    return [{
      annotationId,
      fragments: renderedFragments,
      placement: splitViewport
        ? { ...placement, connectorY: placement.connectorY + size.cardOffsetY }
        : placement,
      preferredY: connectorPreferredEdgeY(renderedFragments),
    }];
  }) : [];
  const edgePorts = spreadConnectorEdgePorts(routes.map((route) => ({
    id: route.annotationId,
    preferredY: route.preferredY,
    targetY: route.placement.connectorY,
  })));
  const items = routes.flatMap(({ annotationId, fragments, placement }) => {
    const geometry = connectorGeometry({
      cardX: size.documentWidth + ANNOTATION_RAIL_CARD_INSET,
      cardY: placement.connectorY,
      documentEdgeX: size.documentWidth,
      edgeY: edgePorts[annotationId],
      fanOutX: size.documentWidth + ANNOTATION_CONNECTOR_FAN_OUT,
      fragments,
      open,
      resolved: true,
    });
    return geometry ? [{ annotationId, geometry }] : [];
  });
  return (
    <AnnotationConnectorLayer
      activeAnnotationId={session.state.activeAnnotationId}
      documentHeight={splitViewport ? size.height : Math.max(size.height, snapshot?.documentHeight ?? 0)}
      hoveredAnnotationId={session.state.hoveredAnnotationId}
      items={items}
      open={open}
      width={size.width}
    />
  );
}

function FilePreviewLoading({ label }: { label: string }) {
  return <LoadingSkeleton className={styles.previewLoading} label={label} />;
}

function FilePreviewFindBar({
  inputRef,
  query,
  matchCount,
  matchIndex,
  focusRequestId,
  onClose,
  onQueryChange,
  onStep,
}: {
  inputRef: RefObject<HTMLInputElement | null>;
  query: string;
  matchCount: number;
  matchIndex: number;
  focusRequestId: number;
  onClose: () => void;
  onQueryChange: (value: string) => void;
  onStep: (direction: 1 | -1) => void;
}) {
  const status = query.trim() ? (matchCount > 0 ? `${matchIndex + 1}/${matchCount}` : "无结果") : "搜索";
  useLayoutEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [focusRequestId, inputRef]);

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      onStep(event.shiftKey ? -1 : 1);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    }
  };

  return (
    <div
      className={styles.findBar}
      role="search"
      aria-label="文件内容搜索"
      data-file-preview-search="true"
      data-file-preview-selection-excluded="true"
    >
      <Search size={14} />
      <input
        ref={inputRef}
        aria-label="搜索文件内容"
        value={query}
        placeholder="搜索"
        onChange={(event) => onQueryChange(event.target.value)}
        onKeyDown={handleKeyDown}
      />
      <span className={styles.findStatus} data-empty={!query.trim() ? "true" : "false"}>
        {status}
      </span>
      <button type="button" aria-label="上一个搜索结果" disabled={matchCount <= 0} onClick={() => onStep(-1)}>
        <ArrowUp size={13} />
      </button>
      <button type="button" aria-label="下一个搜索结果" disabled={matchCount <= 0} onClick={() => onStep(1)}>
        <ArrowDown size={13} />
      </button>
      <button type="button" aria-label="关闭文件搜索" onClick={onClose}>
        <X size={13} />
      </button>
    </div>
  );
}

interface FilePreviewSelectionSnapshot {
  selectedText: string;
  selectionPosition: SelectionPosition | null;
  selectionRange: Range | null;
}

function FilePreviewSelectionLayer({
  bodyRef,
  enabled,
  quoteSelectionAvailable,
  annotationAvailable,
  onQuote,
  onAnnotate,
}: {
  bodyRef: RefObject<HTMLDivElement | null>;
  enabled: boolean;
  quoteSelectionAvailable: boolean;
  annotationAvailable: boolean;
  onQuote: (snapshot: FilePreviewSelectionSnapshot, comment?: string) => void;
  onAnnotate: (snapshot: FilePreviewSelectionSnapshot) => void;
}) {
  const selection = useTextSelection(bodyRef, {
    enabled,
    excludeSelector: FILE_PREVIEW_SELECTION_EXCLUDE_SELECTOR,
  });
  const currentSnapshot = useCallback(
    (selectedText: string): FilePreviewSelectionSnapshot => ({
      selectedText,
      selectionPosition: selection.selectionPosition,
      selectionRange: selection.selectionRange,
    }),
    [selection.selectionPosition, selection.selectionRange],
  );
  const handleQuote = useCallback(
    (selectedText: string, comment?: string) => onQuote(currentSnapshot(selectedText), comment),
    [currentSnapshot, onQuote],
  );
  const handleAnnotate = useCallback(
    (selectedText: string) => onAnnotate(currentSnapshot(selectedText)),
    [currentSnapshot, onAnnotate],
  );

  return (
    <SelectionToolbar
      selectedText={selection.selectedText}
      position={selection.selectionPosition}
      selectionRange={selection.selectionRange}
      onQuote={quoteSelectionAvailable ? handleQuote : undefined}
      onAnnotate={annotationAvailable ? handleAnnotate : undefined}
      onClear={selection.clearSelection}
    />
  );
}

function ResourceAnnotationButton({
  label,
  onClick,
}: {
  label: string;
  onClick(): void;
}) {
  return (
    <div className={styles.resourceAnnotationControl} data-file-preview-selection-excluded="true">
      <button aria-label={label} title={label} type="button" onClick={onClick}>
        <MessageSquarePlus size={14} />
      </button>
    </div>
  );
}

type PreviewKind = "markdown" | "html" | "diff" | "json" | "code" | "text" | "mermaid" | "image";
type FilePreviewFindMode = "preview" | "source" | "split";

interface DomFindMatch {
  id: string;
  type: "dom";
  container: HTMLElement;
  element: HTMLElement;
  ranges: DomFindTextRange[];
}

interface DomFindTextRange {
  end: number;
  start: number;
  textNode: Text;
}

interface DomFindTextRef {
  block: Element | null;
  end: number;
  node: Text | null;
  start: number;
  text: string;
}

interface NormalizedSearchText {
  map: Array<{ end: number; start: number }>;
  text: string;
}

interface CodeMirrorFindMatch {
  id: string;
  type: "codemirror";
  from: number;
  to: number;
}

interface MarkdownPreviewFindMatch {
  id: string;
  type: "markdown";
  blockId: string;
  sourceEnd: number;
  sourceStart: number;
}

interface SplitFindMatch {
  id: string;
  type: "split";
  codeMirror: CodeMirrorFindMatch;
  markdown: MarkdownPreviewFindMatch;
}

type FilePreviewFindMatch = DomFindMatch | CodeMirrorFindMatch | MarkdownPreviewFindMatch | SplitFindMatch;

interface FilePreviewFindScrollLine {
  findMode: FilePreviewFindMode;
  line: number;
  query: string;
  surface: "source" | "markdown" | "split";
}

const FILE_PREVIEW_OPEN_SETTLE_MS = 260;
const FILE_PREVIEW_SPLIT_RENDER_DELAY_MS = 250;
const FILE_PREVIEW_AUTO_SAVE_DELAY_MS = 350;
const ANNOTATION_PANEL_EXIT_MS = 160;
const ANNOTATION_FLASH_ITERATIONS = 1;
const ANNOTATION_FLASH_INTERVAL_MS = 700;
const ANNOTATION_FLASH_MS = ANNOTATION_FLASH_ITERATIONS * ANNOTATION_FLASH_INTERVAL_MS;
const ANNOTATION_POPOVER_ESTIMATED_HEIGHT = 190;
const ANNOTATION_POPOVER_GAP = 10;
const FILE_PREVIEW_SELECTION_EXCLUDE_SELECTOR = "[data-file-preview-selection-excluded='true']";
const FILE_PREVIEW_FIND_MARK_SELECTOR = "[data-file-preview-find-match='true']";
const FILE_PREVIEW_DOM_FIND_MARK_SELECTOR = "[data-file-preview-dom-find-match='true']";
const FILE_PREVIEW_FIND_SELECTION_EXCLUDE_SELECTOR = [
  "[data-file-preview-search='true']",
  "[data-file-preview-selection-excluded='true']",
  "input",
  "textarea",
].join(",");
const FILE_PREVIEW_REVEAL_SCROLL_OPTIONS: ScrollIntoViewOptions = {
  block: "start",
  inline: "nearest",
  behavior: "smooth",
};
const FILE_PREVIEW_FIND_SCROLL_OPTIONS: ScrollIntoViewOptions = {
  block: "center",
  inline: "nearest",
  behavior: "smooth",
};
let activeFilePreviewRoot: HTMLElement | null = null;

function isSelectAllShortcut(event: KeyboardEvent): boolean {
  return (
    event.key.toLowerCase() === "a" &&
    (event.ctrlKey || event.metaKey) &&
    !event.altKey &&
    !event.shiftKey
  );
}

function selectPreviewContentForShortcut(
  target: EventTarget | null,
  root: HTMLElement,
  body: HTMLElement | null,
): boolean {
  if (!body) {
    return false;
  }
  const targetElement = target instanceof Element ? target : null;
  if (targetElement && shouldKeepNativeSelectAll(targetElement)) {
    return false;
  }
  if (
    targetElement &&
    targetElement !== document.body &&
    targetElement !== document.documentElement &&
    !root.contains(targetElement)
  ) {
    return false;
  }
  const content = previewSelectableContent(targetElement, body);
  const selection = window.getSelection?.();
  if (!content || !selection) {
    return false;
  }
  const range = document.createRange();
  range.selectNodeContents(content);
  selection.removeAllRanges();
  selection.addRange(range);
  return true;
}

function shouldKeepNativeSelectAll(target: Element): boolean {
  return Boolean(
    target.closest(
      [
        FILE_PREVIEW_FIND_SELECTION_EXCLUDE_SELECTOR,
        "[data-renderer='codemirror']",
        ".cm-editor",
        "[contenteditable='true']",
        "[contenteditable='']",
      ].join(","),
    ),
  );
}

function previewSelectableContent(target: Element | null, body: HTMLElement): HTMLElement | null {
  const selector = "[data-file-preview-selectable-content='preview']";
  const closest = target?.closest<HTMLElement>(selector);
  if (closest && body.contains(closest)) {
    return closest;
  }
  return body.querySelector<HTMLElement>(selector);
}

interface SourceSelection {
  selectedText: string;
  sourceStart: number;
  sourceEnd: number;
  lineStart: number;
  lineEnd: number;
  columnStart: number;
  columnEnd: number;
}

function sourceSelectionsEqual(a: SourceSelection | null, b: SourceSelection | null): boolean {
  if (a === b) {
    return true;
  }
  if (!a || !b) {
    return false;
  }
  return (
    a.selectedText === b.selectedText &&
    a.sourceStart === b.sourceStart &&
    a.sourceEnd === b.sourceEnd &&
    a.lineStart === b.lineStart &&
    a.lineEnd === b.lineEnd &&
    a.columnStart === b.columnStart &&
    a.columnEnd === b.columnEnd
  );
}

interface SourceLineRevealRequest {
  requestId: number;
  position: number;
  block?: ScrollLogicalPosition;
}

interface CodeMirrorFindState {
  query: string;
  activeFrom: number | null;
  activeTo: number | null;
}

function previewSourceRangeFromSelection(
  selectionRange: Range,
  boundary: HTMLElement,
): { sourceStart: number; sourceEnd: number } | null {
  const allSegments = Array.from(
    boundary.querySelectorAll<HTMLElement>(
      "[data-preview-source-start][data-preview-source-end], [data-markdown-source-start][data-markdown-source-end]",
    ),
  );
  const startSegment = previewSourceSegmentForNode(selectionRange.startContainer, boundary);
  const endSegment = previewSourceSegmentForNode(selectionRange.endContainer, boundary);
  if (!startSegment || !endSegment) {
    return null;
  }
  const startIndex = allSegments.indexOf(startSegment);
  const endIndex = allSegments.indexOf(endSegment);
  if (startIndex < 0 || endIndex < 0) {
    return null;
  }
  const firstIndex = Math.min(startIndex, endIndex);
  const lastIndex = Math.max(startIndex, endIndex);
  const segments = allSegments.slice(firstIndex, lastIndex + 1);
  let sourceStart: number | null = null;
  let sourceEnd: number | null = null;
  for (const segment of segments) {
    const segmentStart = dataInteger(segment.dataset.previewSourceStart ?? segment.dataset.markdownSourceStart);
    const segmentEnd = dataInteger(segment.dataset.previewSourceEnd ?? segment.dataset.markdownSourceEnd);
    const textLength = segment.textContent?.length ?? 0;
    if (segmentStart === null || segmentEnd === null || segmentEnd <= segmentStart || textLength <= 0) {
      continue;
    }
    const localStart = segment === startSegment
      ? textOffsetWithinElement(segment, selectionRange.startContainer, selectionRange.startOffset)
      : 0;
    const localEnd = segment === endSegment
      ? textOffsetWithinElement(segment, selectionRange.endContainer, selectionRange.endOffset)
      : textLength;
    const start = Math.max(0, Math.min(localStart, textLength));
    const end = Math.max(start, Math.min(localEnd, textLength));
    if (end <= start) {
      continue;
    }
    const currentStart = segmentStart + start;
    const currentEnd = Math.min(segmentStart + end, segmentEnd);
    sourceStart = sourceStart === null ? currentStart : Math.min(sourceStart, currentStart);
    sourceEnd = sourceEnd === null ? currentEnd : Math.max(sourceEnd, currentEnd);
  }
  return sourceStart !== null && sourceEnd !== null && sourceEnd > sourceStart
    ? { sourceStart, sourceEnd }
    : null;
}

function previewSourceSegmentForNode(node: Node, boundary: HTMLElement): HTMLElement | null {
  const element = node instanceof Element ? node : node.parentElement;
  const segment = element?.closest<HTMLElement>(
    "[data-preview-source-start][data-preview-source-end], [data-markdown-source-start][data-markdown-source-end]",
  ) ?? null;
  return segment && boundary.contains(segment) ? segment : null;
}

function dataInteger(value: string | undefined): number | null {
  if (value == null || !/^\d+$/.test(value)) {
    return null;
  }
  return Number(value);
}

function textOffsetWithinElement(element: HTMLElement, container: Node, offset: number): number {
  let total = 0;
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode;
    const length = node.textContent?.length ?? 0;
    if (node === container) {
      return total + Math.max(0, Math.min(offset, length));
    }
    total += length;
  }
  if (container === element) {
    let child: ChildNode | null = element.firstChild;
    let childIndex = 0;
    while (child && childIndex < offset) {
      total += child.textContent?.length ?? 0;
      child = child.nextSibling;
      childIndex += 1;
    }
    return total;
  }
  return total;
}

function normalizeSelectionText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function sourcePositionForLine(source: string, line: number): number {
  if (line <= 1) {
    return 0;
  }
  let currentLine = 1;
  for (let index = 0; index < source.length; index += 1) {
    if (source.charCodeAt(index) !== 10) {
      continue;
    }
    currentLine += 1;
    if (currentLine === line) {
      return index + 1;
    }
  }
  return source.length;
}

function filePreviewFindContainers(
  body: HTMLElement | null,
  mode: FilePreviewFindMode,
  sourceUsesCodeMirror: boolean,
): HTMLElement[] {
  if (!body) {
    return [];
  }
  if (mode === "preview") {
    return [filePreviewPanelBody(body, "渲染预览") ?? body];
  }
  if (mode === "source") {
    return sourceUsesCodeMirror ? [] : [filePreviewPanelBody(body, "源码内容") ?? body];
  }
  const containers: HTMLElement[] = [];
  if (!sourceUsesCodeMirror) {
    const sourcePanel = filePreviewPanelBody(body, "源码内容");
    if (sourcePanel) {
      containers.push(sourcePanel);
    }
  }
  const previewPanel = filePreviewPanelBody(body, "渲染预览");
  if (previewPanel) {
    containers.push(previewPanel);
  }
  return containers.length ? containers : [body];
}

function filePreviewPanelBody(body: HTMLElement, panelLabel: "源码内容" | "渲染预览"): HTMLElement | null {
  return body.querySelector<HTMLElement>(`section[aria-label='${panelLabel}'] .${styles.splitPanelBody}`);
}

function collectDomFindMatches(containers: HTMLElement[], query: string): DomFindMatch[] {
  const needle = normalizedSearchText(query).text.toLowerCase();
  if (!containers.length || !needle) {
    return [];
  }
  const matches: DomFindMatch[] = [];
  containers.forEach((container, containerIndex) => {
    const refs: DomFindTextRef[] = [];
    let combinedText = "";
    let previousBlock: Element | null = null;
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (node.nodeType === Node.ELEMENT_NODE) {
          const element = node as Element;
          if (element instanceof HTMLElement && shouldSkipFindTextNode(element)) {
            return NodeFilter.FILTER_REJECT;
          }
          return element.tagName === "BR" ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
        }
        const element = node.parentElement;
        if (!element || shouldSkipFindTextNode(element) || !node.textContent?.trim()) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    let node = walker.nextNode();
    while (node) {
      if (node.nodeType === Node.ELEMENT_NODE) {
        if ((node as Element).tagName === "BR") {
          combinedText = appendFindTextBoundary(refs, combinedText);
        }
        node = walker.nextNode();
        continue;
      }
      const text = node.textContent ?? "";
      if (text) {
        const block = closestFindTextBlock(node.parentElement, container);
        if (previousBlock && block && block !== previousBlock) {
          combinedText = appendFindTextBoundary(refs, combinedText, text);
        }
        const start = combinedText.length;
        combinedText += text;
        refs.push({
          block,
          node: node as Text,
          text,
          start,
          end: combinedText.length,
        });
        previousBlock = block ?? previousBlock;
      }
      node = walker.nextNode();
    }
    const normalizedHaystack = normalizedSearchText(combinedText);
    const haystack = normalizedHaystack.text.toLowerCase();
    let start = haystack.indexOf(needle);
    while (start >= 0) {
      const end = start + needle.length;
      const combinedStart = normalizedHaystack.map[start]?.start ?? 0;
      const combinedEnd = normalizedHaystack.map[end - 1]?.end ?? combinedStart;
      const ranges = domTextRangesForCombinedRange(refs, combinedStart, combinedEnd);
      const firstElement = ranges[0]?.textNode.parentElement;
      if (ranges.length && firstElement) {
        matches.push({
          id: `dom-${containerIndex}-${matches.length}`,
          type: "dom",
          container,
          element: firstElement,
          ranges,
        });
      }
      start = haystack.indexOf(needle, start + Math.max(needle.length, 1));
    }
  });
  return matches;
}

function domTextRangesForCombinedRange(
  refs: DomFindTextRef[],
  start: number,
  end: number,
): DomFindTextRange[] {
  return refs
    .map((ref) => {
      const rangeStart = Math.max(start, ref.start);
      const rangeEnd = Math.min(end, ref.end);
      if (rangeEnd <= rangeStart) {
        return null;
      }
      if (!ref.node) {
        return null;
      }
      return {
        textNode: ref.node,
        start: rangeStart - ref.start,
        end: rangeEnd - ref.start,
      };
    })
    .filter((range): range is DomFindTextRange => Boolean(range));
}

function normalizedSearchText(value: string): NormalizedSearchText {
  let text = "";
  const map: NormalizedSearchText["map"] = [];
  let index = 0;
  while (index < value.length) {
    const char = value[index] ?? "";
    if (/\s/.test(char)) {
      const start = index;
      while (index < value.length && /\s/.test(value[index] ?? "")) {
        index += 1;
      }
      if (text.length > 0) {
        text += " ";
        map.push({ start, end: index });
      }
      continue;
    }
    text += char;
    map.push({ start: index, end: index + 1 });
    index += 1;
  }
  while (text.endsWith(" ")) {
    text = text.slice(0, -1);
    map.pop();
  }
  return { text, map };
}

function closestFindTextBlock(element: Element | null, container: HTMLElement): Element | null {
  let current: Element | null = element;
  while (current && current !== container) {
    if (isFindTextBlockElement(current)) {
      return current;
    }
    current = current.parentElement;
  }
  return current;
}

function isFindTextBlockElement(element: Element): boolean {
  return /^(ADDRESS|ARTICLE|ASIDE|BLOCKQUOTE|DD|DETAILS|DIALOG|DIV|DL|DT|FIELDSET|FIGCAPTION|FIGURE|FOOTER|FORM|H[1-6]|HEADER|HR|LI|MAIN|NAV|OL|P|PRE|SECTION|TABLE|TD|TH|TR|UL)$/.test(
    element.tagName,
  );
}

function appendFindTextBoundary(refs: DomFindTextRef[], combinedText: string, nextText = ""): string {
  if (!combinedText || /\s$/.test(combinedText) || (nextText && /^\s/.test(nextText))) {
    return combinedText;
  }
  const boundaryStart = combinedText.length;
  const nextCombinedText = `${combinedText}\n`;
  refs.push({
    block: null,
    node: null,
    text: "\n",
    start: boundaryStart,
    end: nextCombinedText.length,
  });
  return nextCombinedText;
}

function shouldSkipFindTextNode(element: HTMLElement): boolean {
  return Boolean(
    element.closest(
      [
        "[data-file-preview-search='true']",
        "[data-file-preview-selection-excluded='true']",
        "button",
        "input",
        "select",
        "textarea",
        "script",
        "style",
      ].join(","),
    ),
  );
}

function collectCodeMirrorFindMatches(view: EditorView, query: SearchQuery): CodeMirrorFindMatch[] {
  if (!query.valid) {
    return [];
  }
  const matches: CodeMirrorFindMatch[] = [];
  const cursor = query.getCursor(view.state);
  let current = cursor.next();
  while (!current.done) {
    if (current.value.to > current.value.from) {
      matches.push({
        id: `codemirror-${matches.length}`,
        type: "codemirror",
        from: current.value.from,
        to: current.value.to,
      });
    }
    current = cursor.next();
  }
  return matches;
}

function mergeFilePreviewFindMatches(
  mode: FilePreviewFindMode,
  codeMirrorMatches: CodeMirrorFindMatch[],
  markdownMatches: MarkdownPreviewFindMatch[],
  domMatches: DomFindMatch[],
): FilePreviewFindMatch[] {
  if (mode !== "split") {
    return [...codeMirrorMatches, ...markdownMatches, ...domMatches];
  }

  const markdownBySourceRange = new Map<string, MarkdownPreviewFindMatch>();
  markdownMatches.forEach((match) => {
    markdownBySourceRange.set(findSourceRangeKey(match.sourceStart, match.sourceEnd), match);
  });

  const merged: FilePreviewFindMatch[] = [];
  const usedMarkdownIds = new Set<string>();
  codeMirrorMatches.forEach((codeMirrorMatch) => {
    const markdownMatch = markdownBySourceRange.get(findSourceRangeKey(codeMirrorMatch.from, codeMirrorMatch.to));
    if (!markdownMatch) {
      merged.push(codeMirrorMatch);
      return;
    }
    usedMarkdownIds.add(markdownMatch.id);
    merged.push({
      id: `split-${codeMirrorMatch.from}-${codeMirrorMatch.to}`,
      type: "split",
      codeMirror: codeMirrorMatch,
      markdown: markdownMatch,
    });
  });
  markdownMatches.forEach((match) => {
    if (!usedMarkdownIds.has(match.id)) {
      merged.push(match);
    }
  });

  return [...merged.sort(compareSourceMappedFindMatches), ...domMatches];
}

function findSourceRangeKey(start: number, end: number): string {
  return `${start}:${end}`;
}

function compareSourceMappedFindMatches(left: FilePreviewFindMatch, right: FilePreviewFindMatch): number {
  return sourceMappedFindStart(left) - sourceMappedFindStart(right);
}

function sourceMappedFindStart(match: FilePreviewFindMatch): number {
  if (match.type === "codemirror") {
    return match.from;
  }
  if (match.type === "markdown") {
    return match.sourceStart;
  }
  if (match.type === "split") {
    return match.codeMirror.from;
  }
  return Number.MAX_SAFE_INTEGER;
}

function activeMarkdownFindMatch(match: FilePreviewFindMatch | null): MarkdownPreviewFindMatch | null {
  if (match?.type === "markdown") {
    return match;
  }
  if (match?.type === "split") {
    return match.markdown;
  }
  return null;
}

function activeCodeMirrorFindMatch(match: FilePreviewFindMatch | null): CodeMirrorFindMatch | null {
  if (match?.type === "codemirror") {
    return match;
  }
  if (match?.type === "split") {
    return match.codeMirror;
  }
  return null;
}

function findMatchScrollLine(
  match: FilePreviewFindMatch | null,
  context: {
    findMode: FilePreviewFindMode;
    query: string;
    source: string;
    sourceEditorView: EditorView | null;
  },
): FilePreviewFindScrollLine | null {
  if (!match) {
    return null;
  }
  if (match.type === "codemirror") {
    return {
      findMode: context.findMode,
      line: codeMirrorLineAtOffset(context.sourceEditorView, match.from) ?? lineNumberAtOffset(context.source, match.from),
      query: context.query,
      surface: "source",
    };
  }
  if (match.type === "markdown") {
    return {
      findMode: context.findMode,
      line: lineNumberAtOffset(context.source, match.sourceStart),
      query: context.query,
      surface: "markdown",
    };
  }
  if (match.type === "split") {
    return {
      findMode: context.findMode,
      line:
        codeMirrorLineAtOffset(context.sourceEditorView, match.codeMirror.from) ??
        lineNumberAtOffset(context.source, match.markdown.sourceStart),
      query: context.query,
      surface: "split",
    };
  }
  return null;
}

function sameFindScrollLine(
  previous: FilePreviewFindScrollLine | null,
  next: FilePreviewFindScrollLine | null,
): boolean {
  return Boolean(
    previous &&
      next &&
      previous.findMode === next.findMode &&
      previous.line === next.line &&
      previous.query === next.query &&
      previous.surface === next.surface,
  );
}

function codeMirrorLineAtOffset(view: EditorView | null, offset: number): number | null {
  if (!view) {
    return null;
  }
  return view.state.doc.lineAt(Math.max(0, Math.min(offset, view.state.doc.length))).number;
}

function lineNumberAtOffset(source: string, offset: number): number {
  const target = Math.max(0, Math.min(offset, source.length));
  let line = 1;
  for (let index = 0; index < target; index += 1) {
    if (source.charCodeAt(index) === 10) {
      line += 1;
    }
  }
  return line;
}

function clampFindIndex(index: number, count: number): number {
  if (count <= 0) {
    return -1;
  }
  if (index < 0) {
    return 0;
  }
  return Math.min(index, count - 1);
}

function preferredFindMatchIndex(
  currentIndex: number,
  matches: FilePreviewFindMatch[],
  body: HTMLElement | null,
  sourceEditorView: EditorView | null,
): number {
  if (!matches.length) {
    return -1;
  }
  if (currentIndex >= 0) {
    return clampFindIndex(currentIndex, matches.length);
  }
  const visibleIndex = matches.findIndex((match) => isFindMatchVisible(match, body, sourceEditorView));
  return visibleIndex >= 0 ? visibleIndex : 0;
}

function isFindMatchVisible(
  match: FilePreviewFindMatch,
  body: HTMLElement | null,
  sourceEditorView: EditorView | null,
): boolean {
  if (match.type === "codemirror") {
    return Boolean(sourceEditorView && codeMirrorMatchInViewport(sourceEditorView, match));
  }
  if (match.type === "markdown") {
    return markdownFindMatchInViewport(match, body);
  }
  if (match.type === "split") {
    return (
      Boolean(sourceEditorView && codeMirrorMatchInViewport(sourceEditorView, match.codeMirror)) ||
      markdownFindMatchInViewport(match.markdown, body)
    );
  }
  return domFindMatchInViewport(match, body);
}

function codeMirrorMatchInViewport(view: EditorView, match: CodeMirrorFindMatch): boolean {
  return view.visibleRanges.some((range) => match.to > range.from && match.from < range.to);
}

function domFindMatchInViewport(match: DomFindMatch, body: HTMLElement | null): boolean {
  const container = match.container || body;
  if (!container) {
    return false;
  }
  const firstRange = match.ranges[0];
  if (!firstRange) {
    return false;
  }
  const containerRect = container.getBoundingClientRect();
  const range = document.createRange();
  range.setStart(firstRange.textNode, firstRange.start);
  range.setEnd(firstRange.textNode, firstRange.end);
  if (typeof range.getBoundingClientRect !== "function") {
    range.detach();
    return true;
  }
  const matchRect = range.getBoundingClientRect();
  range.detach();
  if (matchRect.width === 0 && matchRect.height === 0) {
    return false;
  }
  return matchRect.bottom >= containerRect.top && matchRect.top <= containerRect.bottom;
}

function markdownFindMatchInViewport(match: MarkdownPreviewFindMatch, body: HTMLElement | null): boolean {
  if (!body) {
    return false;
  }
  const marker = body.querySelector<HTMLElement>(`[data-find-match-id='${cssString(match.id)}']`);
  if (!marker) {
    const block = body.querySelector<HTMLElement>(`[data-markdown-block-id='${cssString(match.blockId)}']`);
    return markdownBlockMatchLikelyVisible(match, block);
  }
  const block = marker.closest<HTMLElement>("[data-markdown-block-id]");
  const blockVisible = markdownBlockMatchLikelyVisible(match, block);
  if (blockVisible) {
    return true;
  }
  const container = marker.closest<HTMLElement>("[data-virtuoso-scroller='true']") ?? body;
  const containerRect = container.getBoundingClientRect();
  const textNode = firstTextNode(marker);
  if (!textNode) {
    return false;
  }
  const range = document.createRange();
  range.setStart(textNode, 0);
  range.setEnd(textNode, textNode.textContent?.length ?? 0);
  if (typeof range.getBoundingClientRect !== "function") {
    range.detach();
    return true;
  }
  const matchRect = range.getBoundingClientRect();
  range.detach();
  if (matchRect.width === 0 && matchRect.height === 0) {
    return false;
  }
  return matchRect.bottom >= containerRect.top && matchRect.top <= containerRect.bottom;
}

function markdownBlockMatchLikelyVisible(match: MarkdownPreviewFindMatch, block: HTMLElement | null): boolean {
  const blockStart = dataInteger(block?.dataset.markdownSourceStart);
  if (blockStart === null) {
    return false;
  }
  return match.sourceStart > blockStart;
}

function firstTextNode(element: HTMLElement): Text | null {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  return walker.nextNode() as Text | null;
}

function cssString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function applyDomFindHighlights(matches: DomFindMatch[], activeId: string | null): void {
  const matchesByTextNode = new Map<Text, Array<DomFindTextRange & { match: DomFindMatch }>>();
  matches.forEach((match) => {
    match.ranges.forEach((range) => {
      const current = matchesByTextNode.get(range.textNode);
      if (current) {
        current.push({ ...range, match });
        return;
      }
      matchesByTextNode.set(range.textNode, [{ ...range, match }]);
    });
  });

  const assignedElements = new Set<string>();
  matchesByTextNode.forEach((textNodeMatches, textNode) => {
    const parent = textNode.parentNode;
    const text = textNode.textContent ?? "";
    if (!parent || !text) {
      return;
    }

    const fragment = document.createDocumentFragment();
    let cursor = 0;
    textNodeMatches
      .sort((left, right) => left.start - right.start)
      .forEach((range) => {
        if (range.start < cursor || range.end > text.length) {
          return;
        }
        if (cursor < range.start) {
          fragment.appendChild(document.createTextNode(text.slice(cursor, range.start)));
        }
        const mark = document.createElement("mark");
        mark.className = styles.findMark;
        mark.dataset.filePreviewDomFindMatch = "true";
        mark.dataset.filePreviewFindMatch = "true";
        mark.dataset.active = range.match.id === activeId ? "true" : "false";
        mark.textContent = text.slice(range.start, range.end);
        fragment.appendChild(mark);
        if (!assignedElements.has(range.match.id)) {
          range.match.element = mark;
          assignedElements.add(range.match.id);
        }
        cursor = range.end;
      });
    if (cursor < text.length) {
      fragment.appendChild(document.createTextNode(text.slice(cursor)));
    }
    parent.replaceChild(fragment, textNode);
  });
}

function filePreviewRootForTarget(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Node)) {
    return null;
  }
  const element = target instanceof Element ? target : target.parentElement;
  return element?.closest<HTMLElement>("[data-file-preview-root='true']") ?? null;
}

function selectedFilePreviewTextForFind(root: HTMLElement, sourceSelection: SourceSelection | null): string {
  const selection = window.getSelection?.();
  const domSelectionText = selectedDomTextForFind(root, selection);
  if (domSelectionText) {
    return domSelectionText;
  }
  return sourceSelection?.selectedText.trim() ?? "";
}

function selectedDomTextForFind(root: HTMLElement, selection: Selection | null | undefined): string {
  if (!selection || selection.isCollapsed || selection.rangeCount <= 0) {
    return "";
  }
  const selectedText = selection.toString().trim();
  if (!selectedText) {
    return "";
  }
  const range = selection.getRangeAt(0);
  if (!selectionRangeBelongsToRoot(root, range) || selectionRangeTouchesExcludedElement(range)) {
    return "";
  }
  return selectedText;
}

function selectionRangeBelongsToRoot(root: HTMLElement, range: Range): boolean {
  const nodes = [
    range.startContainer,
    range.endContainer,
    range.commonAncestorContainer,
  ];
  if (nodes.some((node) => nodeBelongsToRoot(root, node))) {
    return true;
  }
  try {
    return range.intersectsNode(root);
  } catch {
    return false;
  }
}

function nodeBelongsToRoot(root: HTMLElement, node: Node): boolean {
  const element = node instanceof Element ? node : node.parentElement;
  return Boolean(element && root.contains(element));
}

function selectionRangeTouchesExcludedElement(range: Range): boolean {
  return [
    range.startContainer,
    range.endContainer,
    range.commonAncestorContainer,
  ].some((node) => {
    const element = node instanceof Element ? node : node.parentElement;
    return Boolean(element?.closest(FILE_PREVIEW_FIND_SELECTION_EXCLUDE_SELECTOR));
  });
}

function clearDomFindHighlights(
  container: HTMLElement | null,
  options: { includeControlledMarks?: boolean } = {},
): void {
  if (!container) {
    return;
  }
  const selector = options.includeControlledMarks ? FILE_PREVIEW_FIND_MARK_SELECTOR : FILE_PREVIEW_DOM_FIND_MARK_SELECTOR;
  Array.from(container.querySelectorAll<HTMLElement>(selector)).forEach((mark) => {
    const parent = mark.parentNode;
    if (!parent) {
      return;
    }
    while (mark.firstChild) {
      parent.insertBefore(mark.firstChild, mark);
    }
    parent.removeChild(mark);
    parent.normalize();
  });
}

function scrollFindMatchIntoView(
  match: FilePreviewFindMatch | null,
  markdownRuntime: FileMarkdownRuntimeHostHandle | null,
): void {
  if (match?.type === "dom") {
    match.element.scrollIntoView?.(FILE_PREVIEW_FIND_SCROLL_OPTIONS);
    return;
  }
  if (match?.type === "markdown") {
    markdownRuntime?.revealBlock(match.blockId, { align: "center", behavior: "auto" });
    return;
  }
  if (match?.type === "split") {
    markdownRuntime?.revealBlock(match.markdown.blockId, { align: "center", behavior: "auto" });
  }
}

function isSaveShortcut(event: KeyboardEvent): boolean {
  return (
    event.key.toLowerCase() === "s"
    && (event.ctrlKey || event.metaKey)
    && !event.altKey
    && !event.shiftKey
  );
}

function sourceLineNumbers(source: string, start: number, end: number): { lineStart: number; lineEnd: number } {
  const boundedStart = Math.max(0, Math.min(start, source.length));
  const boundedEnd = Math.max(boundedStart, Math.min(end, source.length));
  let lineStart = 1;
  let lineEnd = 1;
  for (let index = 0; index < boundedEnd; index += 1) {
    if (source.charCodeAt(index) === 10) {
      if (index < boundedStart) lineStart += 1;
      lineEnd += 1;
    }
  }
  return { lineStart, lineEnd: Math.max(lineStart, lineEnd) };
}

const SourceViewer = memo(function SourceViewer({
  content,
  editable,
  language,
  theme,
  annotationAdapter,
  revealLineRequest,
  scrollElement,
  onEditorViewChange,
  onSourceBlur,
  onSourceChange,
  sourceFindState,
  onSelectionChange,
}: {
  content: string;
  editable: boolean;
  kind: PreviewKind;
  language: string;
  theme: "light" | "dark";
  annotationAdapter: SourceAnnotationAdapter;
  revealLineRequest?: SourceLineRevealRequest | null;
  scrollElement: HTMLElement | null;
  onEditorViewChange?: (view: EditorView | null) => void;
  onSourceBlur?: () => void;
  onSourceChange?: (content: string) => void;
  sourceFindState?: CodeMirrorFindState | null;
  onSelectionChange?: (selection: SourceSelection | null) => void;
}) {
  const source = editable ? content : content || "文件为空";
  return (
    <div
      className={styles.sourceViewer}
      data-editable={editable ? "true" : "false"}
      data-renderer="codemirror"
      data-testid="file-source-viewer"
    >
      <CodeMirrorSourceView
        annotationAdapter={annotationAdapter}
        editable={editable}
        language={language}
        source={source}
        theme={theme}
        revealLineRequest={revealLineRequest}
        scrollElement={scrollElement}
        onEditorViewChange={onEditorViewChange}
        onSourceBlur={onSourceBlur}
        onSourceChange={onSourceChange}
        sourceFindState={sourceFindState}
        onSelectionChange={onSelectionChange}
      />
    </div>
  );
});

function PlainSourceView({ source, lineCount }: { source: string; lineCount: number }) {
  return (
    <div className={styles.sourceViewer} data-renderer="plain" data-testid="file-source-viewer">
      <pre className={styles.sourceLineNumbers} aria-hidden="true">
        {lineNumbersText(lineCount)}
      </pre>
      <pre className={styles.sourcePlainCode}>
        <code>{source}</code>
      </pre>
    </div>
  );
}

function CodeMirrorSourceView({
  annotationAdapter,
  editable,
  language,
  source,
  theme,
  revealLineRequest,
  scrollElement,
  onEditorViewChange,
  onSourceBlur,
  onSourceChange,
  sourceFindState,
  onSelectionChange,
  onCreateError,
}: {
  annotationAdapter: SourceAnnotationAdapter;
  editable: boolean;
  language: string;
  source: string;
  theme: "light" | "dark";
  revealLineRequest?: SourceLineRevealRequest | null;
  scrollElement: HTMLElement | null;
  onEditorViewChange?: (view: EditorView | null) => void;
  onSourceBlur?: () => void;
  onSourceChange?: (content: string) => void;
  sourceFindState?: CodeMirrorFindState | null;
  onSelectionChange?: (selection: SourceSelection | null) => void;
  onCreateError?: (error: unknown) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const applyingSourceRef = useRef(false);
  const onSelectionChangeRef = useRef(onSelectionChange);
  const onSourceBlurRef = useRef(onSourceBlur);
  const onSourceChangeRef = useRef(onSourceChange);
  const themeCompartmentRef = useRef<Compartment | null>(null);
  const languageCompartmentRef = useRef<Compartment | null>(null);
  const findCompartmentRef = useRef<Compartment | null>(null);
  const editableCompartmentRef = useRef<Compartment | null>(null);
  const sourceLineSeparatorRef = useRef(sourceLineSeparator(source));
  const normalizedSource = normalizeCodeMirrorSource(source);
  sourceLineSeparatorRef.current = sourceLineSeparator(source);
  if (themeCompartmentRef.current === null) {
    themeCompartmentRef.current = new Compartment();
  }
  if (languageCompartmentRef.current === null) {
    languageCompartmentRef.current = new Compartment();
  }
  if (findCompartmentRef.current === null) {
    findCompartmentRef.current = new Compartment();
  }
  if (editableCompartmentRef.current === null) {
    editableCompartmentRef.current = new Compartment();
  }
  const themeCompartment = themeCompartmentRef.current;
  const languageCompartment = languageCompartmentRef.current;
  const findCompartment = findCompartmentRef.current;
  const editableCompartment = editableCompartmentRef.current;

  useEffect(() => {
    onSelectionChangeRef.current = onSelectionChange;
  }, [onSelectionChange]);

  useEffect(() => {
    onSourceBlurRef.current = onSourceBlur;
    onSourceChangeRef.current = onSourceChange;
  }, [onSourceBlur, onSourceChange]);

  const selectionExtension = useMemo(
    () =>
      EditorView.updateListener.of((update) => {
        if (update.docChanged && !applyingSourceRef.current) {
          onSourceChangeRef.current?.(
            restoreSourceLineSeparator(update.state.sliceDoc(), sourceLineSeparatorRef.current),
          );
        }
        if (!update.selectionSet) {
          return;
        }
        const selectionChangeHandler = onSelectionChangeRef.current;
        const range = update.state.selection.main;
        if (range.empty) {
          selectionChangeHandler?.(null);
          return;
        }
        const from = Math.min(range.from, range.to);
        const to = Math.max(range.from, range.to);
        const selectedText = update.state.doc.sliceString(from, to);
        if (!selectedText.trim()) {
          selectionChangeHandler?.(null);
          return;
        }
        const startLine = update.state.doc.lineAt(from);
        const endLine = update.state.doc.lineAt(to);
        selectionChangeHandler?.({
          selectedText,
          sourceStart: from,
          sourceEnd: to,
          lineStart: startLine.number,
          lineEnd: endLine.number,
          columnStart: from - startLine.from + 1,
          columnEnd: Math.max(1, to - endLine.from + 1),
        });
      }),
    [],
  );

  useEffect(() => {
    const host = hostRef.current;
    if (!host) {
      return;
    }
    let view: EditorView;
    try {
      view = new EditorView({
        parent: host,
        state: EditorState.create({
          doc: normalizedSource,
          extensions: [
            ...codeMirrorBaseExtensions(),
            selectionExtension,
            annotationAdapter.extension,
            themeCompartment.of(codeMirrorTheme(theme)),
            languageCompartment.of(codeMirrorLanguage(language) ?? []),
            findCompartment.of(codeMirrorFindExtension(normalizedSource, sourceFindState ?? null)),
            editableCompartment.of(codeMirrorEditableExtension(editable)),
            EditorState.lineSeparator.of("\n"),
            EditorView.domEventHandlers({
              blur: () => {
                onSourceBlurRef.current?.();
                return false;
              },
            }),
          ],
        }),
      });
    } catch (error) {
      console.error("Failed to initialize CodeMirror source preview", error);
      onEditorViewChange?.(null);
      onSelectionChangeRef.current?.(null);
      onCreateError?.(error);
      return;
    }
    viewRef.current = view;
    const detachAnnotationAdapter = annotationAdapter.attach(view, scrollElement ?? view.scrollDOM);
    onEditorViewChange?.(view);

    return () => {
      if (viewRef.current === view) {
        viewRef.current = null;
      }
      onEditorViewChange?.(null);
      onSelectionChangeRef.current?.(null);
      detachAnnotationAdapter();
      view.destroy();
    };
  }, [annotationAdapter, scrollElement]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) {
      return;
    }
    const currentSource = view.state.sliceDoc();
    if (currentSource === normalizedSource) {
      return;
    }
    applyingSourceRef.current = true;
    try {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: normalizedSource },
      });
    } finally {
      applyingSourceRef.current = false;
    }
  }, [normalizedSource]);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: editableCompartment.reconfigure(codeMirrorEditableExtension(editable)),
    });
  }, [editable, editableCompartment]);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: themeCompartment.reconfigure(codeMirrorTheme(theme)),
    });
  }, [theme, themeCompartment]);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: languageCompartment.reconfigure(codeMirrorLanguage(language) ?? []),
    });
  }, [language, languageCompartment]);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: findCompartment.reconfigure(
        codeMirrorFindExtension(normalizedSource, sourceFindState ?? null),
      ),
    });
  }, [findCompartment, normalizedSource, sourceFindState]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || !revealLineRequest) {
      return;
    }
    const position = Math.max(0, Math.min(revealLineRequest.position, view.state.doc.length));
    smoothScrollCodeMirrorPositionIntoView(view, position, revealLineRequest.block ?? "start", scrollElement);
  }, [revealLineRequest, scrollElement]);

  return (
    <div className={styles.codeMirrorShell}>
      <div ref={hostRef} className={styles.codeMirrorHost} />
    </div>
  );
}

function PreviewScrollPane({
  children,
  className,
  scrollElement,
  ...props
}: PreviewScrollPaneProps) {
  const resolvedChildren = typeof children === "function" ? (scrollElement ? children(scrollElement) : null) : children;

  return (
    <div className={styles.previewScrollShell}>
      <div className={className} {...props}>
        {resolvedChildren}
      </div>
    </div>
  );
}

interface PreviewScrollPaneProps extends Omit<HTMLAttributes<HTMLDivElement>, "children"> {
  className: string;
  children: ReactNode | ((scrollElement: HTMLElement | null) => ReactNode);
  scrollElement?: HTMLElement | null;
}

function isHtmlPreviewViewportMessage(value: unknown): value is {
  type: typeof HTML_PREVIEW_VIEWPORT_MESSAGE_TYPE;
  nearBottom: boolean;
} {
  if (!value || typeof value !== "object") {
    return false;
  }
  const message = value as { type?: unknown; nearBottom?: unknown };
  return message.type === HTML_PREVIEW_VIEWPORT_MESSAGE_TYPE && typeof message.nearBottom === "boolean";
}

const FILE_PREVIEW_SCROLL_MIN_THUMB_SIZE = 36;

const EMPTY_FILE_PREVIEW_SCROLL_METRICS: FilePreviewScrollMetrics = {
  maxScrollTop: 0,
  maxThumbTop: 0,
  trackHeight: 0,
  visible: false,
  thumbTop: 0,
  thumbHeight: 0,
};

interface FilePreviewScrollMetrics {
  maxScrollTop: number;
  maxThumbTop: number;
  trackHeight: number;
  visible: boolean;
  thumbTop: number;
  thumbHeight: number;
}

interface FilePreviewScrollDrag {
  pointerId: number;
  pointerOffsetY: number;
}

interface FilePreviewScrollRepeat {
  interval: number | null;
  pointerId: number;
  timeout: number | null;
}

function FilePreviewScrollRail({
  scrollElement,
  observeSelector,
  railTestId,
  surface,
  thumbTestId,
}: {
  scrollElement: HTMLElement | null;
  observeSelector?: string;
  railTestId?: string;
  surface: "preview" | "source";
  thumbTestId?: string;
}) {
  const railRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<number | null>(null);
  const dragRef = useRef<FilePreviewScrollDrag | null>(null);
  const repeatRef = useRef<FilePreviewScrollRepeat | null>(null);
  const [metrics, setMetrics] = useState<FilePreviewScrollMetrics>(EMPTY_FILE_PREVIEW_SCROLL_METRICS);

  const readMetrics = useCallback((): FilePreviewScrollMetrics => {
    const track = trackRef.current;
    if (!track || !scrollElement) {
      return EMPTY_FILE_PREVIEW_SCROLL_METRICS;
    }
    const trackHeight = track.clientHeight;
    const viewportHeight = scrollElement.clientHeight;
    const scrollHeight = scrollElement.scrollHeight;
    const maxScrollTop = Math.max(0, scrollHeight - viewportHeight);
    if (trackHeight <= 0 || viewportHeight <= 0 || maxScrollTop <= 0) {
      return EMPTY_FILE_PREVIEW_SCROLL_METRICS;
    }
    const thumbHeight = Math.min(
      trackHeight,
      Math.max(FILE_PREVIEW_SCROLL_MIN_THUMB_SIZE, Math.round((viewportHeight / scrollHeight) * trackHeight)),
    );
    const maxThumbTop = Math.max(0, trackHeight - thumbHeight);
    const thumbTop = maxThumbTop <= 0 ? 0 : (scrollElement.scrollTop / maxScrollTop) * maxThumbTop;
    return {
      maxScrollTop,
      maxThumbTop,
      trackHeight,
      visible: true,
      thumbTop: Math.max(0, Math.min(thumbTop, maxThumbTop)),
      thumbHeight,
    };
  }, [scrollElement]);

  const updateMetrics = useCallback(() => {
    const next = readMetrics();
    setMetrics((current) => (
      current.visible === next.visible
      && Math.abs(current.thumbTop - next.thumbTop) < 0.5
      && Math.abs(current.thumbHeight - next.thumbHeight) < 0.5
        ? current
        : next
    ));
  }, [readMetrics]);

  const scheduleMetrics = useCallback(() => {
    if (frameRef.current !== null) {
      return;
    }
    frameRef.current = window.requestAnimationFrame(() => {
      frameRef.current = null;
      updateMetrics();
    });
  }, [updateMetrics]);

  const scrollToThumbTop = useCallback((thumbTop: number, sourceMetrics: FilePreviewScrollMetrics) => {
    if (!scrollElement || !sourceMetrics.visible || sourceMetrics.maxThumbTop <= 0) {
      return;
    }
    const nextThumbTop = clampNumber(thumbTop, 0, sourceMetrics.maxThumbTop);
    scrollElement.scrollTop = (nextThumbTop / sourceMetrics.maxThumbTop) * sourceMetrics.maxScrollTop;
  }, [scrollElement]);

  const scrollByDirection = useCallback((direction: -1 | 1) => {
    if (!scrollElement) {
      return;
    }
    const step = Math.max(32, Math.min(96, Math.round(scrollElement.clientHeight * 0.16)));
    const maxScrollTop = Math.max(0, scrollElement.scrollHeight - scrollElement.clientHeight);
    scrollElement.scrollTop = clampNumber(scrollElement.scrollTop + direction * step, 0, maxScrollTop);
    scheduleMetrics();
  }, [scheduleMetrics, scrollElement]);

  useLayoutEffect(() => {
    updateMetrics();
    if (!scrollElement) {
      return;
    }
    const delayedMeasure = window.setTimeout(scheduleMetrics, 80);
    scrollElement.addEventListener("scroll", scheduleMetrics, { passive: true });
    window.addEventListener("resize", scheduleMetrics);
    const resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(scheduleMetrics);
    resizeObserver?.observe(scrollElement);
    const contentElement = observeSelector
      ? scrollElement.querySelector<HTMLElement>(observeSelector)
      : scrollElement.firstElementChild instanceof HTMLElement
        ? scrollElement.firstElementChild
        : null;
    if (contentElement) {
      resizeObserver?.observe(contentElement);
    }
    if (railRef.current) {
      resizeObserver?.observe(railRef.current);
    }
    if (trackRef.current) {
      resizeObserver?.observe(trackRef.current);
    }
    return () => {
      window.clearTimeout(delayedMeasure);
      scrollElement.removeEventListener("scroll", scheduleMetrics);
      window.removeEventListener("resize", scheduleMetrics);
      resizeObserver?.disconnect();
    };
  }, [observeSelector, scheduleMetrics, scrollElement, updateMetrics]);

  useEffect(() => () => {
    if (frameRef.current !== null) {
      window.cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
    if (repeatRef.current?.timeout !== null && repeatRef.current?.timeout !== undefined) {
      window.clearTimeout(repeatRef.current.timeout);
    }
    if (repeatRef.current?.interval !== null && repeatRef.current?.interval !== undefined) {
      window.clearInterval(repeatRef.current.interval);
    }
    repeatRef.current = null;
  }, []);

  const handlePointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const rail = railRef.current;
    const track = trackRef.current;
    if (!rail || !track || !scrollElement || !metrics.visible) {
      return;
    }
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest(`.${styles.previewScrollButton}`)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const currentMetrics = readMetrics();
    if (!currentMetrics.visible || currentMetrics.maxThumbTop <= 0 || currentMetrics.maxScrollTop <= 0) {
      return;
    }
    const trackRect = track.getBoundingClientRect();
    const thumb = target?.closest<HTMLElement>(`.${styles.previewScrollThumb}`) ?? null;
    let pointerOffsetY = thumb
      ? event.clientY - thumb.getBoundingClientRect().top
      : currentMetrics.thumbHeight / 2;
    pointerOffsetY = clampNumber(pointerOffsetY, 0, currentMetrics.thumbHeight);
    if (!thumb) {
      scrollToThumbTop(event.clientY - trackRect.top - pointerOffsetY, currentMetrics);
      updateMetrics();
    }
    dragRef.current = {
      pointerId: event.pointerId,
      pointerOffsetY,
    };
    rail.dataset.dragging = "true";
    rail.setPointerCapture?.(event.pointerId);
  }, [metrics.visible, readMetrics, scrollElement, scrollToThumbTop, updateMetrics]);

  const handlePointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    const track = trackRef.current;
    if (!drag || drag.pointerId !== event.pointerId || !track || !scrollElement) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const currentMetrics = readMetrics();
    if (!currentMetrics.visible || currentMetrics.maxThumbTop <= 0) {
      return;
    }
    const trackRect = track.getBoundingClientRect();
    scrollToThumbTop(event.clientY - trackRect.top - drag.pointerOffsetY, currentMetrics);
    scheduleMetrics();
  }, [readMetrics, scheduleMetrics, scrollElement, scrollToThumbTop]);

  const finishDrag = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }
    dragRef.current = null;
    delete event.currentTarget.dataset.dragging;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    updateMetrics();
  }, [updateMetrics]);

  const finishButtonScroll = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    const repeat = repeatRef.current;
    if (!repeat || repeat.pointerId !== event.pointerId) {
      return;
    }
    if (repeat.timeout !== null) {
      window.clearTimeout(repeat.timeout);
    }
    if (repeat.interval !== null) {
      window.clearInterval(repeat.interval);
    }
    repeatRef.current = null;
    delete event.currentTarget.dataset.pressing;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  }, []);

  const startButtonScroll = useCallback((event: ReactPointerEvent<HTMLButtonElement>, direction: -1 | 1) => {
    if (!scrollElement || !metrics.visible) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (repeatRef.current?.timeout !== null && repeatRef.current?.timeout !== undefined) {
      window.clearTimeout(repeatRef.current.timeout);
    }
    if (repeatRef.current?.interval !== null && repeatRef.current?.interval !== undefined) {
      window.clearInterval(repeatRef.current.interval);
    }
    scrollByDirection(direction);
    event.currentTarget.dataset.pressing = "true";
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const repeat: FilePreviewScrollRepeat = {
      interval: null,
      pointerId: event.pointerId,
      timeout: window.setTimeout(() => {
        repeat.timeout = null;
        repeat.interval = window.setInterval(() => scrollByDirection(direction), 54);
      }, 280),
    };
    repeatRef.current = repeat;
  }, [metrics.visible, scrollByDirection, scrollElement]);

  return (
    <div
      ref={railRef}
      aria-hidden="true"
      className={styles.previewScrollRail}
      data-surface={surface}
      data-visible={metrics.visible ? "true" : "false"}
      data-testid={railTestId}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={finishDrag}
      onPointerCancel={finishDrag}
    >
      <button
        type="button"
        className={styles.previewScrollButton}
        data-direction="up"
        data-testid={railTestId ? `${railTestId}-up` : undefined}
        tabIndex={-1}
        aria-hidden="true"
        aria-label="Scroll up"
        onPointerCancel={finishButtonScroll}
        onPointerDown={(event) => startButtonScroll(event, -1)}
        onPointerUp={finishButtonScroll}
      />
      <div ref={trackRef} className={styles.previewScrollTrack}>
        <div
          className={styles.previewScrollThumb}
          data-testid={thumbTestId}
          style={{ height: `${metrics.thumbHeight}px`, transform: `translateY(${metrics.thumbTop}px)` }}
        />
      </div>
      <button
        type="button"
        className={styles.previewScrollButton}
        data-direction="down"
        data-testid={railTestId ? `${railTestId}-down` : undefined}
        tabIndex={-1}
        aria-hidden="true"
        aria-label="Scroll down"
        onPointerCancel={finishButtonScroll}
        onPointerDown={(event) => startButtonScroll(event, 1)}
        onPointerUp={finishButtonScroll}
      />
    </div>
  );
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}

function syncScrollProgress(source: HTMLElement, target: HTMLElement): boolean {
  const sourceRange = Math.max(0, source.scrollHeight - source.clientHeight);
  const targetRange = Math.max(0, target.scrollHeight - target.clientHeight);
  const progress = sourceRange > 0 ? clampNumber(source.scrollTop / sourceRange, 0, 1) : 0;
  target.scrollTo({ top: targetRange * progress, behavior: "auto" });
  return true;
}

function centerElementInScrollViewport(
  scrollElement: HTMLElement,
  element: HTMLElement,
  signal: AbortSignal,
): Promise<void> {
  const viewportRect = scrollElement.getBoundingClientRect();
  const elementRect = element.getBoundingClientRect();
  const elementCenter = scrollElement.scrollTop + elementRect.top - viewportRect.top + elementRect.height / 2;
  const maxScrollTop = Math.max(0, scrollElement.scrollHeight - scrollElement.clientHeight);
  const top = clampNumber(elementCenter - scrollElement.clientHeight / 2, 0, maxScrollTop);
  return smoothScrollElementTo(scrollElement, top, signal);
}

function smoothScrollCodeMirrorPositionIntoView(
  view: EditorView,
  position: number,
  block: ScrollLogicalPosition = "start",
  scrollElement: HTMLElement | null = view.scrollDOM,
): void {
  const targetScrollElement = scrollElement ?? view.scrollDOM;
  view.requestMeasure({
    read() {
      const line = view.lineBlockAt(position);
      if (targetScrollElement !== view.scrollDOM) {
        const viewportRect = targetScrollElement.getBoundingClientRect();
        const contentRect = view.contentDOM.getBoundingClientRect();
        return {
          height: line.height,
          top: targetScrollElement.scrollTop + contentRect.top - viewportRect.top + line.top,
        };
      }
      return {
        height: line.height,
        top: Math.max(0, line.top),
      };
    },
    write(line) {
      const centeredTop = line.top - Math.max(0, (targetScrollElement.clientHeight - line.height) / 2);
      const top = block === "center" ? Math.max(0, centeredTop) : line.top;
      if (typeof targetScrollElement.scrollTo === "function") {
        targetScrollElement.scrollTo({ top, behavior: "smooth" });
        return;
      }
      targetScrollElement.scrollTop = top;
    },
  });
}

function codeMirrorFindExtension(source: string, findState: CodeMirrorFindState | null): Extension {
  const ranges = codeMirrorFindDecorationRanges(source, findState).map(({ from, to, active }) =>
    Decoration.mark({
      class: "cm-fileFindMark",
      attributes: {
        "data-file-preview-source-find-match": "true",
        "data-source-end": String(to),
        "data-source-start": String(from),
        "data-active": active ? "true" : "false",
      },
    }).range(from, to),
  );
  return EditorView.decorations.of(Decoration.set(ranges, true));
}

function codeMirrorFindDecorationRanges(
  source: string,
  findState: CodeMirrorFindState | null,
): Array<{ from: number; to: number; active: boolean }> {
  const query = findState?.query.trim() ?? "";
  if (!query) {
    return [];
  }
  const ranges: Array<{ from: number; to: number; active: boolean }> = [];
  const needle = query.toLowerCase();
  const haystack = source.toLowerCase();
  let from = haystack.indexOf(needle);
  while (from >= 0) {
    const to = from + query.length;
    ranges.push({
      from,
      to,
      active: findState?.activeFrom === from && findState.activeTo === to,
    });
    from = haystack.indexOf(needle, from + Math.max(query.length, 1));
  }
  return ranges;
}

function sameCodeMirrorFindState(
  left: CodeMirrorFindState | null,
  right: CodeMirrorFindState | null,
): boolean {
  return (
    (left?.query ?? "") === (right?.query ?? "") &&
    (left?.activeFrom ?? null) === (right?.activeFrom ?? null) &&
    (left?.activeTo ?? null) === (right?.activeTo ?? null)
  );
}

function codeMirrorBaseExtensions(): Extension[] {
  return [
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightSpecialChars(),
    foldGutter({ markerDOM: codeMirrorFoldMarker }),
    indentOnInput(),
    bracketMatching(),
    highlightActiveLine(),
    search({ top: true }),
    highlightSelectionMatches(),
    history(),
    EditorView.lineWrapping,
    keymap.of([...defaultKeymap, ...historyKeymap, ...foldKeymap]),
    syntaxHighlighting(codeMirrorHighlightStyle),
  ].filter(Boolean) as Extension[];
}

function codeMirrorFoldMarker(open: boolean): HTMLElement {
  const marker = document.createElement("span");
  marker.className = "cm-fileFoldMarker";
  marker.dataset.open = open ? "true" : "false";
  marker.setAttribute("aria-label", open ? "折叠代码块" : "展开代码块");
  marker.setAttribute("role", "button");
  marker.title = open ? "折叠代码块" : "展开代码块";
  return marker;
}

function codeMirrorLanguage(language: string): Extension | null {
  switch (language) {
    case "javascript":
    case "js":
    case "mjs":
    case "cjs":
      return javascript();
    case "jsx":
      return javascript({ jsx: true });
    case "typescript":
    case "ts":
      return javascript({ typescript: true });
    case "tsx":
      return javascript({ jsx: true, typescript: true });
    case "json":
      return jsonLanguage();
    case "python":
    case "py":
      return python();
    case "html":
    case "htm":
      return htmlLanguage();
    case "xml":
      return xml();
    case "css":
    case "scss":
    case "sass":
    case "less":
      return cssLanguage();
    case "markdown":
    case "md":
    case "mdx":
      return markdownLanguage();
    case "sql":
      return sql();
    case "yaml":
    case "yml":
      return yaml();
    default:
      return null;
  }
}

function codeMirrorTheme(theme: "light" | "dark"): Extension {
  const dark = theme === "dark";
  return EditorView.theme(
    {
      "&": {
        height: "100%",
        minHeight: "180px",
        backgroundColor: "var(--color-bg-elevated)",
        color: "var(--color-text-primary)",
        fontSize: "13px",
      },
      "&.cm-focused": {
        outline: "none",
      },
      ".cm-scroller": {
        fontFamily: "var(--font-mono)",
        lineHeight: "1.55",
        scrollbarColor: "transparent transparent",
        scrollbarGutter: "auto",
        scrollbarWidth: "none",
      },
      ".cm-scroller::-webkit-scrollbar": {
        width: "0",
        height: "0",
      },
      ".cm-scroller::-webkit-scrollbar-track, .cm-scroller::-webkit-scrollbar-thumb, .cm-scroller::-webkit-scrollbar-corner": {
        border: "0",
        background: "transparent",
      },
      ".cm-content": {
        minHeight: "100%",
        padding: "10px 0 14px",
      },
      ".cm-line": {
        padding: "0 24px",
      },
      ".cm-gutters": {
        backgroundColor: "var(--color-bg-elevated)",
        borderRight: "1px solid color-mix(in srgb, var(--color-border-subtle) 72%, transparent)",
        color: "var(--color-text-tertiary)",
      },
      ".cm-lineNumbers .cm-gutterElement": {
        minWidth: "46px",
        padding: "0 12px 0 8px",
      },
      ".cm-foldGutter": {
        minWidth: "30px",
      },
      ".cm-foldGutter .cm-gutterElement": {
        display: "flex",
        minWidth: "30px",
        alignItems: "center",
        justifyContent: "center",
        padding: "0 4px",
      },
      ".cm-fileFoldMarker": {
        display: "inline-grid",
        width: "18px",
        height: "18px",
        placeItems: "center",
        borderRadius: "var(--radius-xs)",
        color: "var(--color-text-tertiary)",
        cursor: "pointer",
        animation: "filePreviewFoldMarkerIn 160ms var(--motion-ease-out) both",
        transition:
          "background-color var(--motion-fast) var(--motion-ease-standard), color var(--motion-fast) var(--motion-ease-standard), transform var(--motion-fast) var(--motion-ease-standard)",
      },
      ".cm-fileFoldMarker::before": {
        width: "6px",
        height: "6px",
        borderRight: "1.6px solid currentColor",
        borderBottom: "1.6px solid currentColor",
        content: "''",
        transform: "rotate(45deg) translate(-1px, -1px)",
        transition: "transform 180ms var(--motion-ease-standard)",
      },
      ".cm-fileFoldMarker[data-open='false']::before": {
        transform: "rotate(-45deg) translate(-1px, 1px)",
      },
      ".cm-fileFoldMarker:hover": {
        backgroundColor: "var(--surface-hover)",
        color: "var(--color-text-primary)",
      },
      ".cm-fileFoldMarker:active": {
        transform: "scale(0.92)",
      },
      ".cm-activeLineGutter": {
        backgroundColor: "color-mix(in srgb, var(--color-accent) 8%, transparent)",
        color: "var(--color-text-secondary)",
      },
      ".cm-activeLine": {
        backgroundColor: "color-mix(in srgb, var(--color-accent) 5%, transparent)",
      },
      ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
        backgroundColor: "color-mix(in srgb, var(--color-accent) 26%, transparent)",
      },
      ".cm-searchMatch": {
        backgroundColor: "rgb(250 204 21 / 42%)",
        outline: "1px solid rgb(234 179 8 / 42%)",
      },
      ".cm-searchMatch-selected": {
        backgroundColor: "rgb(250 204 21 / 88%)",
        outline: "2px solid color-mix(in srgb, var(--color-text-primary) 58%, transparent)",
        outlineOffset: "1px",
        boxShadow: "0 0 0 4px rgb(250 204 21 / 28%), inset 0 -2px 0 rgb(250 204 21 / 95%)",
        fontWeight: "700",
      },
      ".cm-selectionMatch": {
        backgroundColor: "rgb(250 204 21 / 34%)",
      },
      ".cm-fileFindMark": {
        borderRadius: "3px",
        backgroundColor: "rgb(250 204 21 / 42%)",
        boxShadow: "0 0 0 1px rgb(250 204 21 / 18%)",
      },
      ".cm-fileFindMark[data-active='true']": {
        backgroundColor: "rgb(250 204 21 / 88%)",
        outline: "1.5px solid color-mix(in srgb, var(--color-text-primary) 58%, transparent)",
        outlineOffset: "1px",
        boxShadow: "0 0 0 4px rgb(250 204 21 / 30%), inset 0 -2px 0 rgb(250 204 21 / 95%)",
        fontWeight: "700",
      },
      ".cm-annotation-mark": {
        borderBottom: "1px solid color-mix(in srgb, var(--annotation-accent) 70%, transparent)",
        backgroundColor: "color-mix(in srgb, var(--annotation-accent) 18%, transparent)",
        borderRadius: "3px",
        cursor: "pointer",
        transition:
          "background-color var(--motion-fast) var(--motion-ease-standard), box-shadow var(--motion-fast) var(--motion-ease-standard)",
      },
      ".cm-annotation-mark:hover, .cm-annotation-mark[data-hovered='true']": {
        backgroundColor: "color-mix(in srgb, var(--annotation-accent) 44%, transparent)",
        boxShadow: "inset 0 -2px 0 color-mix(in srgb, var(--annotation-accent) 90%, transparent), 0 0 0 1px color-mix(in srgb, var(--annotation-accent) 62%, transparent)",
      },
      ".cm-foldPlaceholder": {
        display: "inline-flex",
        minWidth: "22px",
        height: "18px",
        alignItems: "center",
        justifyContent: "center",
        border: "1px solid var(--color-border-subtle)",
        borderRadius: "var(--radius-xs)",
        backgroundColor: "var(--surface-muted)",
        color: "var(--color-text-tertiary)",
        fontSize: "12px",
        lineHeight: "1",
        padding: "0 6px",
        animation: "filePreviewFoldPlaceholderIn 180ms var(--motion-ease-out) both",
        transition:
          "background-color var(--motion-fast) var(--motion-ease-standard), border-color var(--motion-fast) var(--motion-ease-standard), color var(--motion-fast) var(--motion-ease-standard)",
      },
      ".cm-foldPlaceholder:hover": {
        borderColor: "color-mix(in srgb, var(--color-accent) 46%, var(--color-border-subtle))",
        backgroundColor: "color-mix(in srgb, var(--color-accent) 8%, var(--surface-muted))",
        color: "var(--color-text-primary)",
      },
      "@keyframes filePreviewFoldMarkerIn": {
        from: {
          opacity: "0",
          transform: "scale(0.82)",
        },
        to: {
          opacity: "1",
          transform: "scale(1)",
        },
      },
      "@keyframes filePreviewFoldPlaceholderIn": {
        from: {
          opacity: "0",
          transform: "translateY(-2px)",
        },
        to: {
          opacity: "1",
          transform: "translateY(0)",
        },
      },
      ".cm-tooltip": {
        border: "1px solid var(--color-border-subtle)",
        borderRadius: "var(--radius-sm)",
        backgroundColor: "var(--color-bg-elevated)",
        color: "var(--color-text-primary)",
        boxShadow: "var(--shadow-popover)",
      },
      ".cm-panel": {
        borderColor: "var(--color-border-subtle)",
        backgroundColor: "var(--color-bg-elevated)",
        color: "var(--color-text-primary)",
      },
      ".cm-panel input": {
        border: "1px solid var(--color-border-subtle)",
        borderRadius: "var(--radius-xs)",
        backgroundColor: "var(--surface-bg)",
        color: "var(--color-text-primary)",
        font: "inherit",
      },
      ".cm-button": {
        border: "0",
        borderRadius: "var(--radius-xs)",
        backgroundImage: "none",
        backgroundColor: "var(--surface-muted)",
        color: "var(--color-text-secondary)",
      },
    },
    { dark },
  );
}

const codeMirrorHighlightStyle = HighlightStyle.define([
  { tag: tags.keyword, color: "var(--syntax-keyword)", fontWeight: "600" },
  { tag: [tags.atom, tags.bool, tags.special(tags.variableName)], color: "var(--syntax-atom)" },
  { tag: [tags.number, tags.integer, tags.float], color: "var(--syntax-number)" },
  { tag: [tags.string, tags.special(tags.string)], color: "var(--syntax-string)" },
  { tag: tags.regexp, color: "var(--syntax-regexp)" },
  { tag: [tags.comment, tags.docComment], color: "var(--syntax-comment)", fontStyle: "italic" },
  { tag: tags.variableName, color: "var(--syntax-variable)" },
  { tag: [tags.definition(tags.variableName), tags.function(tags.variableName)], color: "var(--syntax-function)" },
  { tag: [tags.className, tags.typeName, tags.namespace], color: "var(--syntax-type)" },
  { tag: [tags.propertyName, tags.attributeName], color: "var(--syntax-property)" },
  { tag: tags.operator, color: "var(--syntax-operator)" },
  {
    tag: [tags.punctuation, tags.bracket, tags.squareBracket, tags.paren, tags.brace],
    color: "var(--syntax-punctuation)",
  },
  { tag: [tags.heading, tags.strong], fontWeight: "700", color: "var(--color-text-primary)" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.link, color: "var(--color-accent)", textDecoration: "underline" },
]);

function PathBreadcrumbs({ path, rootLabel }: { path: string; rootLabel?: string }) {
  const displayPath = normalizeBreadcrumbPath(path);
  const pathSegments = displayPath.split(/[\\/]/).filter(Boolean);
  const rootSegment = rootLabel ? fileName(normalizeBreadcrumbPath(rootLabel)) : "";
  const shouldPrependRoot =
    rootSegment && pathSegments[0] !== rootSegment && pathSegments[pathSegments.length - 1] !== rootSegment;
  const displaySegments = [
    ...(shouldPrependRoot ? [rootSegment] : []),
    ...(pathSegments.length > 0 ? pathSegments : [path]),
  ];
  return (
    <div className={styles.pathBreadcrumbs} title={displaySegments.join(" / ")}>
      {displaySegments.map((segment, index) => (
        <span className={styles.pathSegment} key={`${index}-${segment}`}>
          {index > 0 ? <ChevronRight className={styles.pathSeparator} size={14} strokeWidth={1.8} /> : null}
          <span className={styles.pathLabel}>{segment}</span>
        </span>
      ))}
    </div>
  );
}

type MermaidPreviewState =
  | { status: "loading" }
  | { status: "ready"; svg: string; dimensions: SvgDimensions | null }
  | { status: "error"; message: string };

const MERMAID_MIN_SCALE = 0.05;
const MERMAID_MAX_SCALE = 3;
const MERMAID_SCALE_STEP = 0.1;
const MERMAID_FIT_PADDING = 32;
const MERMAID_AUTO_FIT_FRAMES = 40;

interface MermaidDragState {
  pointerId: number;
  startX: number;
  startY: number;
  scrollLeft: number;
  scrollTop: number;
}

function NativeMermaidPreview({
  annotationState = EMPTY_RESOURCE_ANNOTATION_VISUAL_STATE,
  code,
  layout = "panel",
  onAnnotateResource,
  selectable = false,
}: {
  annotationState?: ResourceAnnotationVisualState;
  code: string;
  layout?: "panel" | "document" | "fullscreen";
  onAnnotateResource?: () => void;
  selectable?: boolean;
}) {
  const [theme, setTheme] = useState<"light" | "dark">(() => getTheme());
  const [state, setState] = useState<MermaidPreviewState>({ status: "loading" });
  const [scale, setScale] = useState(1);
  const [fullscreenOpen, setFullscreenOpen] = useState(false);
  const {
    copyState: mermaidCopyState,
    showCopyFeedback: showMermaidCopyFeedback,
    resetCopyFeedback: resetMermaidCopyFeedback,
  } = useCopyFeedback();
  const viewportRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<MermaidDragState | null>(null);
  const autoFitRef = useRef(true);
  const centerFrameRef = useRef<number | null>(null);
  const autoFitFrameRef = useRef<number | null>(null);
  const autoFitAttemptRef = useRef(0);
  const instanceId = useRef(`preview-mermaid-${Math.random().toString(36).slice(2)}`);
  const documentLayout = layout === "document";

  useEffect(() => {
    const themeObserver = new MutationObserver(() => setTheme(getTheme()));
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => themeObserver.disconnect();
  }, []);

  useEffect(() => {
    resetMermaidCopyFeedback();
  }, [code, resetMermaidCopyFeedback]);

  useEffect(() => {
    let cancelled = false;
    const trimmedCode = code.trim();
    if (!trimmedCode) {
      setState({ status: "error", message: "Mermaid 内容为空" });
      return () => {
        cancelled = true;
      };
    }

    const renderId = `${instanceId.current}-${hashText(trimmedCode)}`;
    setState({ status: "loading" });
    autoFitRef.current = true;
    setScale(1);

    void import("mermaid")
      .then(async ({ default: mermaid }) => {
        mermaid.initialize(getMermaidConfig(theme));
        await mermaid.parse(trimmedCode, { suppressErrors: false });
        const renderHost = document.createElement("div");
        renderHost.setAttribute("data-mermaid-render-host", "true");
        renderHost.style.cssText =
          "position:absolute;width:0;height:0;overflow:hidden;opacity:0;pointer-events:none;";
        document.body.appendChild(renderHost);
        try {
          return await mermaid.render(renderId, trimmedCode, renderHost);
        } finally {
          renderHost.remove();
        }
      })
      .then((result) => {
        if (cancelled) {
          return;
        }
        const svg = typeof result === "string" ? result : result.svg;
        const normalized = normalizeMermaidSvgDimensions(svg);
        setState({ status: "ready", svg: normalized.svg, dimensions: normalized.dimensions });
      })
      .catch((reason: unknown) => {
        if (cancelled) {
          return;
        }
        cleanupGlobalMermaidErrors();
        setState({ status: "error", message: errorMessage(reason) });
      });

    return () => {
      cancelled = true;
    };
  }, [code, theme]);

  const cancelCenterViewport = useCallback(() => {
    if (centerFrameRef.current !== null) {
      window.cancelAnimationFrame(centerFrameRef.current);
      centerFrameRef.current = null;
    }
  }, []);

  const scheduleCenterViewport = useCallback((viewport: HTMLElement, dimensions: SvgDimensions, nextScale: number) => {
    if (!autoFitRef.current) {
      return;
    }
    cancelCenterViewport();
    centerMermaidViewport(viewport, dimensions, nextScale);
    centerFrameRef.current = window.requestAnimationFrame(() => {
      centerFrameRef.current = null;
      if (autoFitRef.current) {
        centerMermaidViewport(viewport, dimensions, nextScale);
      }
    });
  }, [cancelCenterViewport]);

  const cancelAutoFitLoop = useCallback(() => {
    if (autoFitFrameRef.current !== null) {
      window.cancelAnimationFrame(autoFitFrameRef.current);
      autoFitFrameRef.current = null;
    }
    cancelCenterViewport();
  }, [cancelCenterViewport]);

  const fitMermaidToViewport = useCallback(() => {
    if (state.status !== "ready" || !state.dimensions) {
      return false;
    }
    const viewport = viewportRef.current;
    if (!viewport) {
      return false;
    }
    syncMermaidCanvasPadding(viewport);
    const next = calculateMermaidFitScale(viewport, state.dimensions);
    if (next === null) {
      return false;
    }
    setScale((current) => (current === next ? current : next));
    scheduleCenterViewport(viewport, state.dimensions, next);
    return true;
  }, [scheduleCenterViewport, state]);

  const scheduleAutoFitLoop = useCallback(() => {
    cancelAutoFitLoop();
    fitMermaidToViewport();
    autoFitAttemptRef.current = 1;

    const tick = () => {
      autoFitFrameRef.current = null;
      if (!autoFitRef.current) {
        return;
      }

      fitMermaidToViewport();
      autoFitAttemptRef.current += 1;

      if (autoFitAttemptRef.current < MERMAID_AUTO_FIT_FRAMES) {
        autoFitFrameRef.current = window.requestAnimationFrame(tick);
      }
    };

    autoFitFrameRef.current = window.requestAnimationFrame(tick);
  }, [cancelAutoFitLoop, fitMermaidToViewport]);

  const zoomBy = useCallback((delta: number, focus?: { clientX: number; clientY: number }) => {
    autoFitRef.current = false;
    cancelAutoFitLoop();
    setScale((current) => {
      const next = clampMermaidScale(current + delta);
      const viewport = viewportRef.current;
      if (focus && viewport && next !== current) {
        preserveMermaidZoomAnchor(viewport, current, next, focus);
      }
      return next;
    });
  }, [cancelAutoFitLoop]);

  const resetZoom = () => {
    autoFitRef.current = true;
    if (state.status !== "ready" || !state.dimensions) {
      setScale(1);
      return;
    }
    scheduleAutoFitLoop();
  };

  const copyMermaidSource = useCallback(async () => {
    try {
      await copyText(code);
      showMermaidCopyFeedback("copied");
    } catch {
      showMermaidCopyFeedback("failed");
    }
  }, [code, showMermaidCopyFeedback]);

  useLayoutEffect(() => {
    if (!autoFitRef.current) {
      return;
    }
    scheduleAutoFitLoop();
  }, [scheduleAutoFitLoop]);

  useEffect(() => {
    if (state.status !== "ready" || !state.dimensions || typeof ResizeObserver === "undefined") {
      return;
    }
    const viewport = viewportRef.current;
    if (!viewport) {
      return;
    }
    const observer = new ResizeObserver(() => {
      if (autoFitRef.current) {
        scheduleAutoFitLoop();
      }
    });
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [scheduleAutoFitLoop, state]);

  useEffect(() => {
    return () => {
      if (centerFrameRef.current !== null) {
        window.cancelAnimationFrame(centerFrameRef.current);
      }
      cancelAutoFitLoop();
    };
  }, [cancelAutoFitLoop]);

  useEffect(() => {
    if (state.status !== "ready") {
      return;
    }
    const viewport = viewportRef.current;
    if (!viewport) {
      return;
    }

    const handleNativeWheel = (event: WheelEvent) => {
      if (Math.abs(event.deltaY) === 0 && Math.abs(event.deltaX) === 0) {
        return;
      }
      if (documentLayout) {
        scrollMarkdownPreviewFromEmbeddedMermaid(viewport, event);
        return;
      }
      if (Math.abs(event.deltaY) === 0) {
        return;
      }
      event.preventDefault();
      zoomBy(event.deltaY < 0 ? MERMAID_SCALE_STEP : -MERMAID_SCALE_STEP, {
        clientX: event.clientX,
        clientY: event.clientY,
      });
    };

    viewport.addEventListener("wheel", handleNativeWheel, { passive: false });
    return () => viewport.removeEventListener("wheel", handleNativeWheel);
  }, [documentLayout, state.status, zoomBy]);

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (documentLayout || state.status !== "ready" || event.button > 0) {
      return;
    }
    autoFitRef.current = false;
    cancelAutoFitLoop();
    dragRef.current = {
      pointerId: pointerIdValue(event),
      startX: pointerCoordinate(event.clientX),
      startY: pointerCoordinate(event.clientY),
      scrollLeft: event.currentTarget.scrollLeft,
      scrollTop: event.currentTarget.scrollTop,
    };
    event.currentTarget.dataset.dragging = "true";
    event.currentTarget.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (documentLayout || !drag || drag.pointerId !== pointerIdValue(event)) {
      return;
    }
    event.currentTarget.scrollLeft = drag.scrollLeft - (pointerCoordinate(event.clientX) - drag.startX);
    event.currentTarget.scrollTop = drag.scrollTop - (pointerCoordinate(event.clientY) - drag.startY);
  };

  const clearDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== pointerIdValue(event)) {
      return;
    }
    dragRef.current = null;
    delete event.currentTarget.dataset.dragging;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  };

  const zoomFromViewportCenter = (delta: number) => {
    const viewport = viewportRef.current;
    if (!viewport) {
      zoomBy(delta);
      return;
    }
    const rect = viewport.getBoundingClientRect();
    zoomBy(delta, {
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
    });
  };

  const documentControls =
    state.status === "ready" ? (
      <div
        className={styles.mermaidDocumentHeader}
        data-file-preview-selection-excluded="true"
      >
        <span>mermaid</span>
        <button
          type="button"
          aria-label="打开 Mermaid 预览"
          title="打开 Mermaid 预览"
          onClick={() => setFullscreenOpen(true)}
        >
          <Maximize2 size={13} />
        </button>
        <button
          type="button"
          aria-label="复制 Mermaid 源码"
          title={mermaidCopyState === "copied" ? "已复制 Mermaid 源码" : "复制 Mermaid 源码"}
          onClick={() => void copyMermaidSource()}
        >
          {mermaidCopyState === "copied" ? <Check size={13} /> : <Copy size={13} />}
        </button>
      </div>
    ) : null;
  const renderDimensions =
    state.status === "ready" && state.dimensions
      ? {
          "--mermaid-render-width": formatMermaidCssPixels(state.dimensions.width * scale),
          "--mermaid-render-height": formatMermaidCssPixels(state.dimensions.height * scale),
        }
      : null;
  const scaleLabel = formatMermaidScale(scale);
  const interactiveControls =
    state.status === "ready" && !documentLayout ? (
      <div
        className={styles.mermaidControls}
        aria-label="Mermaid 视图控制"
        data-file-preview-selection-excluded="true"
      >
        {onAnnotateResource ? (
          <button
            type="button"
            aria-label="批注整个 Mermaid 图表"
            title="批注整个 Mermaid 图表"
            onClick={onAnnotateResource}
          >
            <MessageSquarePlus size={15} />
          </button>
        ) : null}
        <button
          type="button"
          aria-label="缩小 Mermaid"
          title="缩小 Mermaid"
          onClick={() => zoomFromViewportCenter(-MERMAID_SCALE_STEP)}
        >
          <ZoomOut size={15} />
        </button>
        <span className={styles.mermaidScaleValue} aria-label={`当前缩放 ${scaleLabel}`}>
          {scaleLabel}
        </span>
        <button
          type="button"
          aria-label="放大 Mermaid"
          title="放大 Mermaid"
          onClick={() => zoomFromViewportCenter(MERMAID_SCALE_STEP)}
        >
          <ZoomIn size={15} />
        </button>
        <button type="button" aria-label="重置 Mermaid 视图" title="重置 Mermaid 视图" onClick={resetZoom}>
          <RotateCcw size={15} />
        </button>
      </div>
    ) : null;

  return (
    <>
      <div
        className={styles.mermaidPane}
        data-markdown-code-frame={documentLayout ? "true" : undefined}
        data-markdown-code-language={documentLayout ? "mermaid" : undefined}
        data-file-preview-selectable-content={selectable ? "preview" : undefined}
        data-layout={layout}
        data-resource-annotation-active={annotationState.active ? "true" : undefined}
        data-resource-annotation-highlight={annotationState.highlighted ? "true" : undefined}
        data-resource-annotation-hovered={annotationState.hovered ? "true" : undefined}
        data-testid="preview-mermaid-pane"
      >
        {documentLayout ? documentControls : null}
        {interactiveControls}
        {state.status === "ready" ? (
          <div
            ref={viewportRef}
            className={
              documentLayout
                ? `${styles.mermaidSvg} ${styles.mermaidDocumentViewport}`
                : styles.mermaidSvg
            }
            aria-label="Mermaid 图表"
            data-file-preview-selection-excluded={selectable ? "true" : undefined}
            data-interactive={documentLayout ? "false" : "true"}
            style={
              {
                "--mermaid-scale": scale,
                ...renderDimensions,
              } as CSSProperties
            }
            onPointerCancel={clearDrag}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={clearDrag}
          >
            <div
              className={styles.mermaidSvgContent}
              data-sized={state.dimensions ? "true" : "false"}
              dangerouslySetInnerHTML={{ __html: state.svg }}
            />
          </div>
        ) : state.status === "error" ? (
          <div className={styles.mermaidStatus} role="alert">
            {state.message}
          </div>
        ) : (
          <div className={styles.mermaidStatus} aria-hidden="true" />
        )}
      </div>
      {fullscreenOpen ? (
        <FilePreviewFullscreenDialog title="Mermaid 预览" onClose={() => setFullscreenOpen(false)}>
          <NativeMermaidPreview code={code} layout="fullscreen" />
        </FilePreviewFullscreenDialog>
      ) : null}
    </>
  );
}

function clampMermaidScale(value: number): number {
  return Math.min(MERMAID_MAX_SCALE, Math.max(MERMAID_MIN_SCALE, Math.round(value * 100) / 100));
}

function scrollMarkdownPreviewFromEmbeddedMermaid(viewport: HTMLElement, event: WheelEvent): void {
  const scrollParent = viewport.closest<HTMLElement>("[data-document-scroll-viewport='true']");
  if (!scrollParent) {
    return;
  }
  event.preventDefault();
  scrollParent.scrollTop += event.deltaY;
  scrollParent.scrollLeft += event.deltaX;
}

function FilePreviewFullscreenDialog({
  children,
  onClose,
  title,
}: {
  children: ReactNode;
  onClose: () => void;
  title: string;
}) {
  return (
    <AppDialog
      title={title}
      size="fullscreen"
      placement="fullscreen"
      backdrop="preview"
      closeLabel="关闭 Mermaid 预览"
      onClose={onClose}
    >
      {children}
    </AppDialog>
  );
}

function normalizeBreadcrumbPath(path: string): string {
  return path
    .replace(/^\\\\\?\\UNC\\/i, "\\\\")
    .replace(/^\/\/\?\/UNC\//i, "//")
    .replace(/^\\\\\?\\/i, "")
    .replace(/^\/\/\?\//i, "");
}

function calculateMermaidFitScale(viewport: HTMLElement, dimensions: SvgDimensions): number | null {
  const availableWidth = viewport.clientWidth - MERMAID_FIT_PADDING;
  const availableHeight = viewport.clientHeight - MERMAID_FIT_PADDING;
  if (availableWidth <= 0 || availableHeight <= 0) {
    return null;
  }
  return clampMermaidScale(Math.min(availableWidth / dimensions.width, availableHeight / dimensions.height));
}

function formatMermaidScale(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function pointerIdValue(event: ReactPointerEvent<HTMLElement>): number {
  return Number.isFinite(event.pointerId) ? event.pointerId : 1;
}

function pointerCoordinate(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function getTheme(): "light" | "dark" {
  return document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
}

function hashText(text: string): string {
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) >>> 0;
  }
  return hash.toString(36);
}

function cleanupGlobalMermaidErrors() {
  document.querySelectorAll(".error-icon, .error-text").forEach((element) => {
    const svg = element.closest("svg");
    const wrapper = svg?.parentElement;
    if (!svg || !wrapper) {
      return;
    }
    if (wrapper.parentElement === document.body && wrapper.id.startsWith("dmermaid-")) {
      wrapper.remove();
      return;
    }
    if (svg.parentElement === document.body && svg.id.startsWith("mermaid-")) {
      svg.remove();
    }
  });
}

function workspaceScope({
  workspaceId,
  sessionId,
}: {
  workspaceId?: string;
  sessionId?: string;
}): WorkspaceScope | null {
  if (sessionId) {
    return { sessionId };
  }
  if (workspaceId) {
    return { workspaceId };
  }
  return null;
}

function runtimeLinkedFilePreviewRequest(
  sourceRequest: FilePreviewRequest,
  target: Extract<MarkdownResolvedLinkTarget, { kind: "file" }>,
): Extract<PreviewRequest, { type: "file" | "local-file" }> | null {
  if (target.absolute) {
    return { type: "local-file", path: target.path };
  }

  let sourcePath: string | null = null;
  let type: "file" | "local-file" = "file";
  if (sourceRequest.type === "file") {
    sourcePath = sourceRequest.path;
  } else if (sourceRequest.type === "local-file") {
    sourcePath = sourceRequest.path;
    type = "local-file";
  } else if (sourceRequest.type === "content" && sourceRequest.sourcePath) {
    sourcePath = sourceRequest.sourcePath;
    type = isAbsoluteFilePath(sourcePath) ? "local-file" : "file";
  }

  const path = sourcePath
    ? resolveRelativeFileLinkPath(target.path, sourcePath)
    : target.path;
  return path ? { type, path } : null;
}

function findMarkdownOutlineTarget(
  outline: readonly MarkdownSnapshotOutlineEntry[],
  fragment: string,
): MarkdownSnapshotOutlineEntry | null {
  let decodedFragment = fragment;
  try {
    decodedFragment = decodeURIComponent(fragment);
  } catch {
    // Keep the literal fragment so malformed encoding cannot break link activation.
  }
  const normalizedFragment = decodedFragment.trim();
  if (!normalizedFragment) return null;

  const direct = outline.find((item) => item.id === fragment || item.id === normalizedFragment);
  if (direct) return direct;

  const duplicateCounts = new Map<string, number>();
  for (const item of outline) {
    if (item.title.trim() === normalizedFragment) return item;
    const baseSlug = markdownHeadingSlug(item.title);
    const duplicateIndex = duplicateCounts.get(baseSlug) ?? 0;
    duplicateCounts.set(baseSlug, duplicateIndex + 1);
    const slug = duplicateIndex === 0 ? baseSlug : `${baseSlug}-${duplicateIndex}`;
    if (slug === normalizedFragment) return item;
  }
  return null;
}

function markdownHeadingSlug(title: string): string {
  return title
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, "")
    .replace(/\s+/gu, "-");
}

function immediatePreviewContent(request: FilePreviewRequest): string | null {
  if (request.type === "content" || request.type === "skill-resource") {
    return request.content || "";
  }
  if (request.type === "diff") {
    return request.diff || "暂无 diff";
  }
  if (request.type === "diff-document") {
    return diffDocumentRawSource(request) || "暂无 diff";
  }
  return null;
}

function isPathPreviewRequest(
  request: FilePreviewRequest,
): request is Extract<FilePreviewRequest, { type: "file" | "local-file" }> {
  return request.type === "file" || request.type === "local-file";
}

function defaultViewMode(request: FilePreviewRequest): "preview" | "source" {
  const kind = detectPreviewKind(request);
  return kind === "markdown" || kind === "html" || kind === "diff" || kind === "mermaid" ? "preview" : "source";
}

function detectPreviewKind(request: FilePreviewRequest): PreviewKind {
  if (request.type === "content" || request.type === "skill-resource") {
    return contentKindToPreviewKind(request.contentType);
  }
  if (request.type === "diff" || request.type === "diff-document") {
    return "diff";
  }
  const path = isPathPreviewRequest(request) ? request.path : "";
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  if (["md", "mdx", "markdown"].includes(ext)) {
    return "markdown";
  }
  if (["html", "htm", "xml"].includes(ext)) {
    return "html";
  }
  if (["diff", "patch"].includes(ext)) {
    return "diff";
  }
  if (["png", "jpg", "jpeg", "webp", "gif", "bmp", "svg", "ico", "avif"].includes(ext)) {
    return "image";
  }
  if (ext === "json") {
    return "json";
  }
  if (
    [
      "ts",
      "tsx",
      "js",
      "jsx",
      "mjs",
      "cjs",
      "py",
      "rs",
      "go",
      "java",
      "kt",
      "cs",
      "cpp",
      "c",
      "h",
      "css",
      "scss",
      "sass",
      "less",
      "sql",
      "yaml",
      "yml",
      "toml",
      "sh",
      "bash",
      "ps1",
      "vue",
    ].includes(ext)
  ) {
    return "code";
  }
  return "text";
}

function contentKindToPreviewKind(kind: PreviewContentKind): PreviewKind {
  if (kind === "mermaid") {
    return "mermaid";
  }
  return kind;
}

function sourceLanguage(request: FilePreviewRequest, kind: PreviewKind): string {
  if (request.type === "content") {
    return kind === "mermaid" ? "mermaid" : kind;
  }
  if (request.type === "skill-resource") {
    const ext = request.resourcePath.split(".").pop()?.toLowerCase() ?? "";
    return languageFromExtension(ext, kind);
  }
  if (request.type === "diff" || request.type === "diff-document") {
    return "diff";
  }
  const ext = isPathPreviewRequest(request) ? request.path.split(".").pop()?.toLowerCase() ?? "" : "";
  return languageFromExtension(ext, kind);
}

function languageFromExtension(ext: string, kind: PreviewKind): string {
  const languageByExtension: Record<string, string> = {
    cjs: "javascript",
    css: "css",
    diff: "diff",
    go: "go",
    htm: "html",
    html: "html",
    java: "java",
    js: "javascript",
    json: "json",
    jsx: "jsx",
    md: "markdown",
    mdx: "markdown",
    patch: "diff",
    py: "python",
    rs: "rust",
    scss: "scss",
    sh: "bash",
    sql: "sql",
    ts: "typescript",
    tsx: "tsx",
    vue: "xml",
    xml: "xml",
    yaml: "yaml",
    yml: "yaml",
  };
  return languageByExtension[ext] ?? (kind === "code" ? ext || "text" : kind);
}

function countLines(text: string): number {
  if (!text) {
    return 1;
  }
  let lines = 1;
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) {
      lines += 1;
    }
  }
  return lines;
}

function lineNumbersText(lineCount: number): string {
  return Array.from({ length: Math.max(1, lineCount) }, (_, index) => String(index + 1)).join("\n");
}

function ImagePreview({
  media,
  title,
  sourceLabel,
}: {
  media: WorkspaceMediaResponse | null;
  title: string;
  sourceLabel: string;
}) {
  return (
    <ImagePreviewSurface
      src={media?.data_url}
      alt={title || sourceLabel}
      title={title}
      sourceLabel={sourceLabel}
      mediaType={media?.media_type}
      size={media?.size}
      unavailableText="图片未加载"
    />
  );
}

function codeMirrorEditableExtension(editable: boolean): Extension {
  return [
    EditorState.readOnly.of(!editable),
    EditorView.editable.of(editable),
  ];
}

function sourceLineSeparator(source: string): "\n" | "\r\n" {
  return source.includes("\r\n") ? "\r\n" : "\n";
}

function normalizeCodeMirrorSource(source: string): string {
  return source.replace(/\r\n?/gu, "\n");
}

function restoreSourceLineSeparator(source: string, lineSeparator: "\n" | "\r\n"): string {
  return lineSeparator === "\r\n" ? source.replace(/\n/gu, "\r\n") : source;
}

function previewRequestIdentity(
  request: FilePreviewRequest,
  workspaceId?: string,
  sessionId?: string,
): string {
  if (request.type === "file") {
    return `file:${workspaceId ?? ""}:${sessionId ?? ""}:${normalizePreviewEventPath(request.path)}`;
  }
  if (request.type === "local-file") {
    return `local-file:${request.path.trim()}`;
  }
  if (request.type === "diff") {
    return `diff:${request.path}:${stableMarkdownIdentityHash(request.diff)}`;
  }
  if (request.type === "diff-document") {
    return `diff-document:${request.document.id}:${request.document.sourceVersion}`;
  }
  if (request.type === "skill-resource") {
    return [
      "skill-resource",
      request.skillSource,
      request.skillName,
      request.resourcePath,
      request.revision,
    ].join(":");
  }
  return [
    "content",
    request.title,
    request.contentType,
    request.sourcePath ?? "",
    stableMarkdownIdentityHash(request.content),
  ].join(":");
}

function normalizePreviewEventPath(path: string): string {
  return path.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}

function previewTitle(request: FilePreviewRequest): string {
  if (request.type === "content" || request.type === "skill-resource" || request.type === "diff-document") {
    return request.title;
  }
  return fileName(request.path);
}

function previewSourceLabel(request: FilePreviewRequest): string {
  if (request.type === "skill-resource") {
    return `Skill · ${request.skillName}/${request.resourcePath}`;
  }
  if (request.type === "content") {
    return request.sourcePath ?? "消息内容";
  }
  if (request.type === "diff-document") {
    return request.sourceLabel ?? request.sourcePath ?? "差异内容";
  }
  return request.path;
}

function fileName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() || path;
}

function errorMessage(reason: unknown): string {
  if (reason instanceof Error && reason.message) {
    return reason.message;
  }
  if (reason && typeof reason === "object" && typeof (reason as { message?: unknown }).message === "string") {
    return (reason as { message: string }).message;
  }
  return "文件预览失败";
}

let nextFilePreviewConsumerId = 1;
let nextFilePreviewViewId = 1;
