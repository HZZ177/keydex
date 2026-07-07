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
  Pencil,
  RotateCcw,
  Send,
  Target,
  Trash2,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
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
  defaultHighlightStyle,
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
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  type ReactNode,
  type WheelEvent as ReactWheelEvent,
} from "react";
import { createPortal } from "react-dom";

import type {
  RuntimeBridge,
  WorkspaceFileAnnotation,
  WorkspaceFileAnnotationAnchorV2,
  WorkspaceMediaResponse,
  WorkspaceScope,
} from "@/runtime";
import { AppDialog } from "@/renderer/components/dialog";
import { MarkdownImage } from "@/renderer/pages/conversation/messages/MarkdownImage";
import { SelectionToolbar } from "@/renderer/pages/conversation/messages/SelectionToolbar";
import { copyText } from "@/renderer/pages/conversation/messages/markdown";
import { useTextSelection, type SelectionPosition } from "@/renderer/pages/conversation/messages/useTextSelection";
import {
  APP_FIND_SHORTCUT_EVENT,
  isFindShortcutEvent,
  type AppFindShortcutDetail,
} from "@/renderer/events/findShortcut";
import {
  subscribeStartWorkspaceFileAnnotation,
  type StartWorkspaceFileAnnotationDetail,
} from "@/renderer/events/workspaceFileContext";
import {
  useOptionalPreview,
  type PreviewAnnotationChatRequest,
  type PreviewFileRevealTarget,
  type PreviewQuoteSelectionRequest,
} from "@/renderer/providers/PreviewProvider";
import { LoadingSkeleton } from "@/renderer/components/loading";
import type { PreviewContentKind, PreviewRequest } from "@/renderer/providers/previewTypes";
import {
  centerMermaidViewport,
  formatMermaidCssPixels,
  normalizeMermaidSvgDimensions,
  preserveMermaidZoomAnchor,
  syncMermaidCanvasPadding,
  type SvgDimensions,
} from "@/renderer/utils/mermaidSvg";
import { getMermaidConfig } from "@/renderer/utils/mermaidConfig";
import { parseUnifiedDiffDisplayLines } from "@/renderer/utils/unifiedDiff";

import { createSourceRangeAnchor, validateSourceRangeAnchor } from "./filePreviewAnnotations";
import {
  buildMarkdownAnnotationIndex,
  buildMarkdownFindIndex,
  defaultMarkdownBlockRenderers,
  markdownDocumentModelCache,
  VirtualMarkdownPreview,
  type MarkdownBlockRendererRegistry,
  type MarkdownDocumentModel,
  type VirtualMarkdownPreviewHandle,
} from "./markdownPreviewEngine";
import { ImagePreviewSurface } from "./ImagePreviewSurface";
import styles from "./FilePreview.module.css";

export type FilePreviewRequest = PreviewRequest;

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

type AnnotationWorkspaceRuntime = Pick<
  RuntimeBridge["workspace"],
  "listAnnotations" | "createAnnotation" | "updateAnnotation" | "deleteAnnotation"
>;

export interface FilePreviewProps {
  workspaceId?: string;
  sessionId?: string;
  request: FilePreviewRequest;
  runtime?: RuntimeBridge;
  onQuoteSelection?: (request: PreviewQuoteSelectionRequest) => void;
  onStartChatFromAnnotation?: (request: PreviewAnnotationChatRequest | PreviewAnnotationChatRequest[]) => void;
  onMarkdownOutlineChange?: (outline: MarkdownOutlineItem[]) => void;
  outlineRevealRequest?: MarkdownOutlineRevealRequest | null;
  sourceRevealRequest?: FilePreviewRevealRequest | null;
  onClose?: () => void;
  chrome?: "default" | "panel";
  breadcrumbRootLabel?: string;
  hideBreadcrumbs?: boolean;
}

export function FilePreview({
  workspaceId,
  sessionId,
  request,
  runtime,
  onQuoteSelection,
  onStartChatFromAnnotation,
  onMarkdownOutlineChange,
  outlineRevealRequest,
  sourceRevealRequest,
  onClose,
  chrome = "default",
  breadcrumbRootLabel,
  hideBreadcrumbs = false,
}: FilePreviewProps) {
  const previewRootRef = useRef<HTMLElement | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const markdownPreviewRef = useRef<VirtualMarkdownPreviewHandle | null>(null);
  const findInputRef = useRef<HTMLInputElement | null>(null);
  const panelChrome = chrome === "panel";
  const usesFileOpenDelay = panelChrome && isPathPreviewRequest(request);
  const kind = useMemo(() => detectPreviewKind(request), [request]);
  const immediateContent = useMemo(() => immediatePreviewContent(request), [request]);
  const [content, setContent] = useState(() => immediatePreviewContent(request) ?? "");
  const [media, setMedia] = useState<WorkspaceMediaResponse | null>(null);
  const [loading, setLoading] = useState(isPathPreviewRequest(request));
  const [fileOpenSettling, setFileOpenSettling] = useState(usesFileOpenDelay);
  const previewContent = immediateContent ?? content;
  const previewLoading = immediateContent === null ? loading : false;
  const [error, setError] = useState<string | null>(null);
  const renderedPreviewContent = previewContent;
  const [markdownModel, setMarkdownModel] = useState<MarkdownDocumentModel | null>(null);
  const [markdownModelPreparing, setMarkdownModelPreparing] = useState(false);
  const markdownPreparing = kind === "markdown" && !previewLoading && !error && markdownModelPreparing;
  const previewBusy = previewLoading || fileOpenSettling || markdownPreparing;
  const [viewMode, setViewMode] = useState<"preview" | "source">("preview");
  const [splitMode, setSplitMode] = useState(false);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const [theme, setTheme] = useState<"light" | "dark">(() => getTheme());
  const previewContext = useOptionalPreview();
  const previewEntries = previewContext?.entries ?? [];
  const activePreviewId = previewContext?.activeEntryId ?? null;
  const showPreviewTabs = previewEntries.length > 1;
  const scope = useMemo(() => workspaceScope({ workspaceId, sessionId }), [workspaceId, sessionId]);
  const annotationScope = useMemo(() => annotationWorkspaceScope({ workspaceId, sessionId }), [workspaceId, sessionId]);
  const annotationPath = request.type === "file" || request.type === "local-file" ? request.path : null;
  const revealPath = isPathPreviewRequest(request)
    ? request.path
    : request.type === "content"
      ? request.sourcePath ?? null
      : null;
  const annotationRuntime = useMemo(() => annotationWorkspaceRuntime(runtime), [runtime]);
  const quoteSelectionAvailable = Boolean(onQuoteSelection && annotationPath);
  const annotationAvailable = Boolean(
    annotationPath &&
      annotationScope &&
      annotationRuntime,
  );
  const [annotations, setAnnotations] = useState<WorkspaceFileAnnotation[]>([]);
  const [annotationsLoading, setAnnotationsLoading] = useState(false);
  const [annotationError, setAnnotationError] = useState<string | null>(null);
  const [annotationReloadId, setAnnotationReloadId] = useState(0);
  const [fileAnnotationDraft, setFileAnnotationDraft] = useState("");
  const [fileAnnotationComposerOpen, setFileAnnotationComposerOpen] = useState(false);
  const [fileAnnotationComposerFocusRequestId, setFileAnnotationComposerFocusRequestId] = useState(0);
  const [selectionDraft, setSelectionDraft] = useState<SelectionAnnotationDraft | null>(null);
  const [editingAnnotationId, setEditingAnnotationId] = useState<string | null>(null);
  const [editingComment, setEditingComment] = useState("");
  const [annotationMutationError, setAnnotationMutationError] = useState<string | null>(null);
  const [annotationMutatingId, setAnnotationMutatingId] = useState<string | null>(null);
  const sourceSelectionRef = useRef<SourceSelection | null>(null);
  const updateSourceSelection = useCallback((nextSelection: SourceSelection | null) => {
    if (!sourceSelectionsEqual(sourceSelectionRef.current, nextSelection)) {
      sourceSelectionRef.current = nextSelection;
    }
  }, []);
  const [lineRevealRequest, setLineRevealRequest] = useState<SourceLineRevealRequest | null>(null);
  const [previewRevealRequest, setPreviewRevealRequest] = useState<PreviewAnnotationRevealRequest | null>(null);
  const [transientRevealAnnotation, setTransientRevealAnnotation] = useState<WorkspaceFileAnnotation | null>(null);
  const [sourceEditorView, setSourceEditorView] = useState<EditorView | null>(null);
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [findFocusRequestId, setFindFocusRequestId] = useState(0);
  const [findMatchCount, setFindMatchCount] = useState(0);
  const [findMatchIndex, setFindMatchIndex] = useState(-1);
  const [activeMarkdownFindMatchId, setActiveMarkdownFindMatchId] = useState<string | null>(null);
  const [sourceFindState, setSourceFindState] = useState<CodeMirrorFindState | null>(null);
  const [annotationPanelOpen, setAnnotationPanelOpen] = useState(false);
  const [annotationPanelClosing, setAnnotationPanelClosing] = useState(false);
  const [activeAnnotationPopover, setActiveAnnotationPopover] = useState<AnnotationPopoverState | null>(null);
  const [focusedAnnotationId, setFocusedAnnotationId] = useState<string | null>(null);
  const [flashAnnotationId, setFlashAnnotationId] = useState<string | null>(null);
  const [selectionDraftPopover, setSelectionDraftPopover] = useState<AnnotationDraftPopoverState | null>(null);
  const [selectionMappingError, setSelectionMappingError] = useState<string | null>(null);
  const [locateError, setLocateError] = useState<string | null>(null);
  const annotationPanelOpenRef = useRef(annotationPanelOpen);
  const annotationPanelClosingRef = useRef(annotationPanelClosing);
  const annotationPanelCloseTimerRef = useRef<number | null>(null);
  const annotationFlashTimerRef = useRef<number | null>(null);
  const annotationPopoverFrameRef = useRef<number | null>(null);
  const transientRevealAnnotationRef = useRef<WorkspaceFileAnnotation | null>(null);
  const handledSourceRevealRequestIdRef = useRef(0);
  const lastFindScrollLineRef = useRef<FilePreviewFindScrollLine | null>(null);

  const clearTransientReveal = useCallback(() => {
    const annotationId = transientRevealAnnotationRef.current?.id ?? null;
    transientRevealAnnotationRef.current = null;
    setTransientRevealAnnotation(null);
    if (!annotationId) {
      return;
    }
    setFocusedAnnotationId((current) => (current === annotationId ? null : current));
    setFlashAnnotationId((current) => (current === annotationId ? null : current));
  }, []);

  useEffect(() => {
    transientRevealAnnotationRef.current = transientRevealAnnotation;
  }, [transientRevealAnnotation]);

  useEffect(() => {
    const themeObserver = new MutationObserver(() => setTheme(getTheme()));
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => themeObserver.disconnect();
  }, []);

  useEffect(() => {
    return () => {
      if (annotationPanelCloseTimerRef.current !== null) {
        window.clearTimeout(annotationPanelCloseTimerRef.current);
      }
      if (annotationFlashTimerRef.current !== null) {
        window.clearTimeout(annotationFlashTimerRef.current);
      }
      if (annotationPopoverFrameRef.current !== null) {
        window.cancelAnimationFrame(annotationPopoverFrameRef.current);
      }
    };
  }, []);

  const hasAnchoredAnnotationPopover = Boolean(activeAnnotationPopover || selectionDraftPopover);
  useEffect(() => {
    annotationPanelOpenRef.current = annotationPanelOpen;
    annotationPanelClosingRef.current = annotationPanelClosing;
  }, [annotationPanelClosing, annotationPanelOpen]);

  useEffect(() => {
    if (!hasAnchoredAnnotationPopover) {
      return;
    }
    const updatePopoverPositions = () => {
      if (annotationPopoverFrameRef.current !== null) {
        return;
      }
      annotationPopoverFrameRef.current = window.requestAnimationFrame(() => {
        annotationPopoverFrameRef.current = null;
        setActiveAnnotationPopover((current) => (current ? repositionPopoverState(current) : current));
        setSelectionDraftPopover((current) => (current ? repositionPopoverState(current) : current));
      });
    };
    window.addEventListener("scroll", updatePopoverPositions, true);
    window.addEventListener("resize", updatePopoverPositions);
    return () => {
      window.removeEventListener("scroll", updatePopoverPositions, true);
      window.removeEventListener("resize", updatePopoverPositions);
      if (annotationPopoverFrameRef.current !== null) {
        window.cancelAnimationFrame(annotationPopoverFrameRef.current);
        annotationPopoverFrameRef.current = null;
      }
    };
  }, [hasAnchoredAnnotationPopover]);

  useEffect(() => {
    if (!hasAnchoredAnnotationPopover) {
      return;
    }
    const closeOnOutsidePointerDown = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest(FILE_PREVIEW_ANNOTATION_POPOVER_SELECTOR)) {
        return;
      }
      setActiveAnnotationPopover(null);
      setSelectionDraft(null);
      setSelectionDraftPopover(null);
      setFocusedAnnotationId(null);
    };
    document.addEventListener("pointerdown", closeOnOutsidePointerDown, true);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePointerDown, true);
  }, [hasAnchoredAnnotationPopover]);

  const openAnnotationPanel = useCallback(() => {
    if (annotationPanelCloseTimerRef.current !== null) {
      window.clearTimeout(annotationPanelCloseTimerRef.current);
      annotationPanelCloseTimerRef.current = null;
    }
    setActiveAnnotationPopover(null);
    setSelectionDraft(null);
    setSelectionDraftPopover(null);
    setAnnotationPanelClosing(false);
    annotationPanelOpenRef.current = true;
    annotationPanelClosingRef.current = false;
    setAnnotationPanelOpen(true);
  }, []);

  const closeAnnotationPanel = useCallback(() => {
    if (!annotationPanelOpenRef.current || annotationPanelClosingRef.current) {
      return;
    }
    annotationPanelClosingRef.current = true;
    setAnnotationPanelClosing(true);
    annotationPanelCloseTimerRef.current = window.setTimeout(() => {
      annotationPanelCloseTimerRef.current = null;
      annotationPanelOpenRef.current = false;
      annotationPanelClosingRef.current = false;
      setAnnotationPanelOpen(false);
      setAnnotationPanelClosing(false);
      setFileAnnotationComposerOpen(false);
    }, ANNOTATION_PANEL_EXIT_MS);
  }, []);

  const toggleAnnotationPanel = useCallback(() => {
    if (annotationPanelOpenRef.current && !annotationPanelClosingRef.current) {
      closeAnnotationPanel();
      return;
    }
    openAnnotationPanel();
  }, [closeAnnotationPanel, openAnnotationPanel]);

  const openFileAnnotationComposer = useCallback(() => {
    if (!annotationPath) {
      return;
    }
    setActiveAnnotationPopover(null);
    setSelectionDraft(null);
    setSelectionDraftPopover(null);
    setEditingAnnotationId(null);
    setEditingComment("");
    setAnnotationMutationError(null);
    setSelectionMappingError(null);
    setLocateError(null);
    openAnnotationPanel();
    setFileAnnotationComposerOpen(true);
    setFileAnnotationComposerFocusRequestId((requestId) => requestId + 1);
  }, [annotationPath, openAnnotationPanel]);

  useEffect(() => {
    if (!annotationPanelOpen || annotationPanelClosing) {
      return;
    }
    const closePanelOnOutsidePointerDown = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target || target.closest(FILE_PREVIEW_SELECTION_EXCLUDE_SELECTOR)) {
        return;
      }
      closeAnnotationPanel();
    };
    document.addEventListener("pointerdown", closePanelOnOutsidePointerDown, true);
    return () => document.removeEventListener("pointerdown", closePanelOnOutsidePointerDown, true);
  }, [annotationPanelClosing, annotationPanelOpen, closeAnnotationPanel]);

  useEffect(() => {
    if (!annotationPath) {
      return;
    }
    return subscribeStartWorkspaceFileAnnotation((detail) => {
      if (!isWorkspaceFileAnnotationRequestForPreview(detail, annotationPath, workspaceId, sessionId)) {
        return;
      }
      openFileAnnotationComposer();
    });
  }, [annotationPath, openFileAnnotationComposer, sessionId, workspaceId]);

  useEffect(() => {
    let active = true;
    setError(null);
    setMedia(null);
    setCopyState("idle");
    setViewMode(defaultViewMode(request));
    setSplitMode(false);

    if (request.type === "content") {
      setContent(request.content || "");
      setLoading(false);
      return () => {
        active = false;
      };
    }

    if (request.type === "diff") {
      setContent(request.diff || "暂无 diff");
      setLoading(false);
      return () => {
        active = false;
      };
    }

    setContent("");
    if (!runtime || (request.type === "file" && !scope)) {
      setError("工作区预览运行时未就绪");
      setLoading(false);
      return () => {
        active = false;
      };
    }

    setLoading(true);
    const loader =
      request.type === "local-file"
        ? kind === "image"
          ? runtime.localPreview.readMedia(request.path).then((response) => {
              if (active) {
                setMedia(response);
              }
            })
          : runtime.localPreview.readFile(request.path).then((response) => {
              if (active) {
                setContent(response.content);
              }
            })
        : kind === "image"
          ? runtime.workspace.readMedia(scope as WorkspaceScope, request.path).then((response) => {
              if (active) {
                setMedia(response);
              }
            })
          : runtime.workspace.readFile(scope as WorkspaceScope, request.path).then((response) => {
              if (active) {
                setContent(response.content);
              }
            });

    void loader
      .catch((reason) => {
        if (active) {
          setError(errorMessage(reason));
        }
      })
      .finally(() => {
        if (active) {
          setLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, [kind, scope, runtime, request]);

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
  }, [request, usesFileOpenDelay]);

  useEffect(() => {
    sourceSelectionRef.current = null;
    setSelectionDraft(null);
    setEditingAnnotationId(null);
    setEditingComment("");
    setActiveAnnotationPopover(null);
    setSelectionDraftPopover(null);
    setAnnotationMutationError(null);
    if (annotationPanelCloseTimerRef.current !== null) {
      window.clearTimeout(annotationPanelCloseTimerRef.current);
      annotationPanelCloseTimerRef.current = null;
    }
    annotationPanelOpenRef.current = false;
    annotationPanelClosingRef.current = false;
    setAnnotationPanelOpen(false);
    setAnnotationPanelClosing(false);
    setFileAnnotationComposerOpen(false);
  }, [annotationPath]);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    setAnnotations([]);
    setAnnotationError(null);

    if (!annotationAvailable || !annotationPath || !annotationScope || !annotationRuntime) {
      setAnnotationsLoading(false);
      return () => {
        active = false;
        controller.abort();
      };
    }

    setAnnotationsLoading(true);
    void annotationRuntime
      .listAnnotations(annotationScope, annotationPath, { signal: controller.signal })
      .then((records) => {
        if (active) {
          setAnnotations(records);
        }
      })
      .catch((reason) => {
        if (active && !isAbortError(reason)) {
          setAnnotationError(errorMessage(reason));
        }
      })
      .finally(() => {
        if (active) {
          setAnnotationsLoading(false);
        }
      });

    return () => {
      active = false;
      controller.abort();
    };
  }, [annotationAvailable, annotationPath, annotationReloadId, annotationRuntime, annotationScope]);

  const title = previewTitle(request);
  const canPreview = kind === "markdown" || kind === "html" || kind === "mermaid";
  const canRenderPreview = canPreview || kind === "diff";
  const canSplit = kind === "markdown" || kind === "html";
  const sourceLabel = previewSourceLabel(request);
  const formattedSource = useMemo(() => formatSource(renderedPreviewContent, kind), [kind, renderedPreviewContent]);
  useEffect(() => {
    if (kind !== "markdown" || previewLoading || fileOpenSettling || error) {
      setMarkdownModel(null);
      setMarkdownModelPreparing(false);
      return;
    }

    let active = true;
    setMarkdownModel(null);
    setMarkdownModelPreparing(true);
    const cancelBuild = scheduleMarkdownModelBuild(renderedPreviewContent, { deferLarge: !usesFileOpenDelay }, () => {
      const model = markdownDocumentModelCache.getOrCreate({
        cacheKey: sourceLabel,
        idPrefix: "file-preview",
        source: renderedPreviewContent,
      });
      if (!active) {
        return;
      }
      setMarkdownModel(model);
      setMarkdownModelPreparing(false);
    });

    return () => {
      active = false;
      cancelBuild();
    };
  }, [error, fileOpenSettling, kind, previewLoading, renderedPreviewContent, sourceLabel, usesFileOpenDelay]);
  const markdownOutline = useMemo(
    () =>
      markdownModel
        ? markdownModel.outline.map((item) => ({
          id: item.id,
          level: item.level,
          line: item.lineStart,
          title: item.title,
        }))
        : [],
    [markdownModel],
  );
  const markdownContent = renderedPreviewContent || "文件为空";
  const renderMarkdownImage = useCallback(
    ({ alt, src }: { alt: string; src: string }) => (
      <MarkdownImage
        alt={alt}
        src={src}
        workspaceScope={scope}
        runtime={runtime}
        sourcePath={sourceLabel}
      />
    ),
    [runtime, scope, sourceLabel],
  );
  const markdownRendererRegistry = useMemo<MarkdownBlockRendererRegistry>(
    () => ({
      fence: (props) => {
        const language = props.block.metadata.language?.toLowerCase() ?? "";
        if (language.startsWith("mermaid")) {
          return (
            <div {...props.blockAttributes}>
              <NativeMermaidPreview code={props.block.textContent} layout="document" />
            </div>
          );
        }
        return defaultMarkdownBlockRenderers.fence?.(props) ?? null;
      },
    }),
    [],
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

  const selectionAnnotations = useMemo(
    () => {
      const persistedAnnotations = annotations.filter(
        (annotation) =>
          annotation.anchor_type === "selection" && Boolean((annotation.selected_text || "").trim()),
      );
      return transientRevealAnnotation
        ? [...persistedAnnotations, transientRevealAnnotation]
        : persistedAnnotations;
    },
    [annotations, transientRevealAnnotation],
  );
  const activeAnnotation = useMemo(
    () => annotations.find((annotation) => annotation.id === activeAnnotationPopover?.annotationId) ?? null,
    [activeAnnotationPopover?.annotationId, annotations],
  );
  const activeAnnotationId = activeAnnotationPopover?.annotationId ?? focusedAnnotationId;
  const markdownAnnotationIndex = useMemo(
    () => (markdownModel ? buildMarkdownAnnotationIndex(markdownModel, selectionAnnotations) : []),
    [markdownModel, selectionAnnotations],
  );

  const activateAnnotation = useCallback(
    (annotation: WorkspaceFileAnnotation, position: AnnotationClientPosition) => {
      if (isTransientRevealAnnotationId(annotation.id)) {
        return;
      }
      closeAnnotationPanel();
      setSelectionDraft(null);
      setSelectionDraftPopover(null);
      setAnnotationMutationError(null);
      setFocusedAnnotationId(annotation.id);
      setActiveAnnotationPopover({
        annotationId: annotation.id,
        ...createPopoverState(
          {
            x: position.clientX,
            y: position.clientY,
            width: position.width ?? 0,
            height: position.height ?? 0,
          },
          position.anchorElement ?? bodyRef.current,
          bodyRef.current,
        ),
      });
    },
    [closeAnnotationPanel],
  );

  const currentContentHash = useMemo(
    () => (annotationPath && kind !== "image" && renderedPreviewContent ? hashText(renderedPreviewContent) : null),
    [annotationPath, kind, renderedPreviewContent],
  );

  const createFileAnnotation = useCallback(async () => {
    const comment = fileAnnotationDraft.trim();
    if (!annotationAvailable || !annotationPath || !annotationScope || !annotationRuntime || !comment) {
      return;
    }
    setAnnotationMutationError(null);
    setAnnotationMutatingId("create-file");
    try {
      const created = await annotationRuntime.createAnnotation(annotationScope, {
        path: annotationPath,
        anchor_type: "file",
        comment,
        content_hash: currentContentHash,
      });
      setAnnotations((current) => [created, ...current.filter((item) => item.id !== created.id)]);
      setFileAnnotationDraft("");
    } catch (reason) {
      setAnnotationMutationError(errorMessage(reason));
    } finally {
      setAnnotationMutatingId(null);
    }
  }, [annotationAvailable, annotationPath, annotationRuntime, annotationScope, currentContentHash, fileAnnotationDraft]);

  const startSelectionAnnotation = useCallback(
    (selectionSnapshot: FilePreviewSelectionSnapshot) => {
      const text = selectionSnapshot.selectedText.trim();
      if (!text) {
        return;
      }
      const anchor = selectionAnchorFromCurrentSelection(
        formattedSource,
        kind === "markdown" ? "preview" : "source",
        text,
        sourceSelectionRef.current,
        selectionSnapshot.selectionRange,
        bodyRef.current,
      );
      if (!anchor) {
        setSelectionMappingError("当前选区无法映射到文件源码，不能添加批注。");
        return;
      }
      const selectionPosition = selectionSnapshot.selectionPosition;
      setSelectionDraft({
        anchor,
        selectedText: text,
        comment: "",
        lineStart: anchor.lineStart,
        lineEnd: anchor.lineEnd,
        columnStart: anchor.columnStart,
        columnEnd: anchor.columnEnd,
      });
      setSelectionDraftPopover({
        ...createPopoverState(
          {
            x: selectionPosition?.x ?? window.innerWidth / 2,
            y: selectionPosition?.y ?? 120,
            width: selectionPosition?.width ?? 0,
            height: selectionPosition?.height ?? 0,
          },
          currentSelectionElement(bodyRef.current),
          bodyRef.current,
        ),
      });
      setActiveAnnotationPopover(null);
      closeAnnotationPanel();
      setAnnotationMutationError(null);
      setSelectionMappingError(null);
    },
    [closeAnnotationPanel, formattedSource, kind],
  );

  const quotePreviewSelection = useCallback(
    (selectionSnapshot: FilePreviewSelectionSnapshot) => {
      const text = selectionSnapshot.selectedText.trim();
      if (!text || !annotationPath) {
        return;
      }
      const anchor = selectionAnchorFromCurrentSelection(
        formattedSource,
        kind === "markdown" ? "preview" : "source",
        text,
        sourceSelectionRef.current,
        selectionSnapshot.selectionRange,
        bodyRef.current,
      );
      onQuoteSelection?.({
        path: annotationPath,
        selectedText: text,
        lineStart: anchor?.lineStart ?? null,
        lineEnd: anchor?.lineEnd ?? null,
        sourceStart: anchor?.sourceStart ?? null,
        sourceEnd: anchor?.sourceEnd ?? null,
      });
    },
    [annotationPath, formattedSource, kind, onQuoteSelection],
  );

  const createSelectionAnnotation = useCallback(async () => {
    const comment = selectionDraft?.comment.trim() ?? "";
    if (!annotationAvailable || !annotationPath || !annotationScope || !annotationRuntime || !selectionDraft || !comment) {
      return;
    }
    setAnnotationMutationError(null);
    setAnnotationMutatingId("create-selection");
    try {
      const created = await annotationRuntime.createAnnotation(annotationScope, {
        path: annotationPath,
        anchor_type: "selection",
        comment,
        selected_text: selectionDraft.selectedText,
        line_start: selectionDraft.lineStart,
        line_end: selectionDraft.lineEnd,
        column_start: selectionDraft.columnStart,
        column_end: selectionDraft.columnEnd,
        content_hash: selectionDraft.anchor.contentHash,
        anchor_json: selectionDraft.anchor,
      });
      setAnnotations((current) => [created, ...current.filter((item) => item.id !== created.id)]);
      setSelectionDraft(null);
      setSelectionDraftPopover(null);
      setSelectionMappingError(null);
    } catch (reason) {
      setAnnotationMutationError(errorMessage(reason));
    } finally {
      setAnnotationMutatingId(null);
    }
  }, [annotationAvailable, annotationPath, annotationRuntime, annotationScope, selectionDraft]);

  const beginEditAnnotation = useCallback(
    (annotation: WorkspaceFileAnnotation) => {
      const element = findAnnotationElement(bodyRef.current, annotation.id);
      if (element) {
        const rect = element.getBoundingClientRect();
        activateAnnotation(annotation, {
          clientX: rect.left + rect.width / 2,
          clientY: rect.top,
          width: rect.width,
          height: rect.height,
          anchorElement: element,
        });
        return;
      }
      setEditingAnnotationId(annotation.id);
      setEditingComment(annotation.comment);
      setAnnotationMutationError(null);
    },
    [activateAnnotation],
  );

  const saveAnnotationComment = useCallback(
    async (annotation: WorkspaceFileAnnotation, value: string) => {
      const comment = value.trim();
      if (!annotationAvailable || !annotationScope || !annotationRuntime || !comment) {
        return false;
      }
      setAnnotationMutationError(null);
      setAnnotationMutatingId(`edit:${annotation.id}`);
      try {
        const updated = await annotationRuntime.updateAnnotation(annotationScope, annotation.id, { comment });
        setAnnotations((current) => current.map((item) => (item.id === updated.id ? updated : item)));
        return true;
      } catch (reason) {
        setAnnotationMutationError(errorMessage(reason));
        return false;
      } finally {
        setAnnotationMutatingId(null);
      }
    },
    [annotationAvailable, annotationRuntime, annotationScope],
  );

  const saveAnnotationEdit = useCallback(
    async (annotation: WorkspaceFileAnnotation) => {
      const saved = await saveAnnotationComment(annotation, editingComment);
      if (saved) {
        setEditingAnnotationId(null);
        setEditingComment("");
      }
    },
    [editingComment, saveAnnotationComment],
  );

  const deleteAnnotation = useCallback(
    async (annotation: WorkspaceFileAnnotation) => {
      if (!annotationAvailable || !annotationScope || !annotationRuntime) {
        return;
      }
      setAnnotationMutationError(null);
      setAnnotationMutatingId(`delete:${annotation.id}`);
      try {
        await annotationRuntime.deleteAnnotation(annotationScope, annotation.id);
        setAnnotations((current) => current.filter((item) => item.id !== annotation.id));
        setActiveAnnotationPopover((current) =>
          current?.annotationId === annotation.id ? null : current,
        );
        setFocusedAnnotationId((current) => (current === annotation.id ? null : current));
      } catch (reason) {
        setAnnotationMutationError(errorMessage(reason));
      } finally {
        setAnnotationMutatingId(null);
      }
    },
    [annotationAvailable, annotationRuntime, annotationScope],
  );

  const startChatFromAnnotation = useCallback(
    (annotation: WorkspaceFileAnnotation) => {
      onStartChatFromAnnotation?.(annotationChatRequest(annotation));
      setActiveAnnotationPopover((current) =>
        current?.annotationId === annotation.id ? null : current,
      );
    },
    [onStartChatFromAnnotation],
  );

  const startChatFromAllAnnotations = useCallback(
    (items: WorkspaceFileAnnotation[]) => {
      const requests = items
        .map(annotationChatRequest)
        .filter((request) => request.path.trim() && request.comment.trim());
      if (!requests.length) {
        return;
      }
      onStartChatFromAnnotation?.(requests);
      setActiveAnnotationPopover(null);
    },
    [onStartChatFromAnnotation],
  );

  const flashAnnotation = useCallback((annotationId: string) => {
    if (annotationFlashTimerRef.current !== null) {
      window.clearTimeout(annotationFlashTimerRef.current);
    }
    setFlashAnnotationId(null);
    window.requestAnimationFrame(() => {
      setFlashAnnotationId(annotationId);
      annotationFlashTimerRef.current = window.setTimeout(() => {
        annotationFlashTimerRef.current = null;
        setFlashAnnotationId((current) => (current === annotationId ? null : current));
      }, ANNOTATION_FLASH_MS);
    });
  }, []);

  const revealAnnotationLine = useCallback(
    (
      annotation: WorkspaceFileAnnotation,
      { flash = true, block = "start" }: { flash?: boolean; block?: ScrollLogicalPosition } = {},
    ) => {
      const range = annotationSourceRange(formattedSource, annotation);
      if (!range) {
        return false;
      }
      setLineRevealRequest((current) => ({
        requestId: (current?.requestId ?? 0) + 1,
        position: range.from,
        block,
      }));
      setFocusedAnnotationId(annotation.id);
      if (flash) {
        flashAnnotation(annotation.id);
      }
      return true;
    },
    [flashAnnotation, formattedSource],
  );

  const scrollAnnotationElementIntoView = useCallback(
    (annotation: WorkspaceFileAnnotation, element: HTMLElement, { flash = true }: { flash?: boolean } = {}) => {
      element.scrollIntoView?.(FILE_PREVIEW_REVEAL_SCROLL_OPTIONS);
      setFocusedAnnotationId(annotation.id);
      if (flash) {
        flashAnnotation(annotation.id);
      }
    },
    [flashAnnotation],
  );

  const revealAnnotation = useCallback(
    (annotation: WorkspaceFileAnnotation) => {
      if (!annotation.selected_text) {
        return;
      }
      setFocusedAnnotationId(annotation.id);
      const existingElement = !splitMode ? findAnnotationElement(bodyRef.current, annotation.id) : null;
      if (existingElement) {
        scrollAnnotationElementIntoView(annotation, existingElement, { flash: false });
        setLocateError(null);
        return;
      }
      let located = false;
      if (viewMode === "preview" || splitMode) {
        const previewElement = findPreviewAnnotationElement(bodyRef.current, annotation.id);
        if (previewElement) {
          scrollAnnotationElementIntoView(annotation, previewElement, { flash: false });
          located = true;
        } else if (kind === "markdown" && markdownPreviewRef.current?.scrollToAnnotation(annotation.id, "center")) {
          setFocusedAnnotationId(annotation.id);
          located = true;
        }
      }
      if (viewMode === "source" || splitMode) {
        located = revealAnnotationLine(annotation, { flash: false }) || located;
      }
      if (located) {
        flashAnnotation(annotation.id);
        setLocateError(null);
        return;
      }
      setLocateError("当前视图无法定位该批注片段。");
    },
    [flashAnnotation, kind, revealAnnotationLine, scrollAnnotationElementIntoView, splitMode, viewMode],
  );

  useEffect(() => {
    if (!previewRevealRequest) {
      return;
    }
    const annotation = annotations.find((item) => item.id === previewRevealRequest.annotationId);
    if (!annotation) {
      return;
    }
    const element = findAnnotationElement(bodyRef.current, annotation.id);
    if (element) {
      scrollAnnotationElementIntoView(annotation, element);
      return;
    }
    if (kind === "markdown" && markdownPreviewRef.current?.scrollToAnnotation(annotation.id, "center")) {
      setFocusedAnnotationId(annotation.id);
      flashAnnotation(annotation.id);
      return;
    }
    revealAnnotationLine(annotation);
  }, [annotations, flashAnnotation, kind, previewRevealRequest, revealAnnotationLine, scrollAnnotationElementIntoView]);

  useEffect(() => {
    clearTransientReveal();
    handledSourceRevealRequestIdRef.current = 0;
  }, [annotationPath, clearTransientReveal]);

  useEffect(() => {
    if (!sourceRevealRequest || !revealPath || previewBusy || error) {
      return;
    }
    if (handledSourceRevealRequestIdRef.current === sourceRevealRequest.requestId) {
      return;
    }
    const annotation = transientRevealAnnotationFromRequest(
      formattedSource,
      revealPath,
      sourceRevealRequest,
      annotationScope,
    );
    handledSourceRevealRequestIdRef.current = sourceRevealRequest.requestId;
    if (!annotation) {
      clearTransientReveal();
      return;
    }
    setLocateError(null);
    setTransientRevealAnnotation(annotation);
    setFocusedAnnotationId(annotation.id);
    flashAnnotation(annotation.id);
  }, [
    clearTransientReveal,
    error,
    flashAnnotation,
    formattedSource,
    annotationScope,
    previewBusy,
    revealPath,
    sourceRevealRequest,
  ]);

  useLayoutEffect(() => {
    if (!transientRevealAnnotation) {
      return;
    }
    let located = false;
    if (viewMode !== "source" || splitMode) {
      const element = findPreviewAnnotationElement(bodyRef.current, transientRevealAnnotation.id);
      if (element) {
        element.scrollIntoView?.(FILE_PREVIEW_TRANSIENT_REVEAL_SCROLL_OPTIONS);
        located = true;
      } else if (kind === "markdown" && markdownPreviewRef.current?.scrollToAnnotation(transientRevealAnnotation.id, "center")) {
        window.requestAnimationFrame(() => {
          findPreviewAnnotationElement(bodyRef.current, transientRevealAnnotation.id)
            ?.scrollIntoView?.(FILE_PREVIEW_TRANSIENT_REVEAL_SCROLL_OPTIONS);
        });
        located = true;
      }
    }
    if (viewMode === "source" || splitMode) {
      located = revealAnnotationLine(transientRevealAnnotation, { flash: false, block: "center" }) || located;
    }
    if (located) {
      setLocateError(null);
    }
  }, [kind, renderedPreviewContent, revealAnnotationLine, splitMode, transientRevealAnnotation, viewMode]);

  useLayoutEffect(() => {
    updatePreviewAnnotationMarkState(bodyRef.current, activeAnnotationId, flashAnnotationId);
  }, [activeAnnotationId, flashAnnotationId, renderedPreviewContent, selectionAnnotations, splitMode, viewMode]);

  useEffect(() => {
    if (!outlineRevealRequest || kind !== "markdown") {
      return;
    }
    const outlineItem = markdownModel?.outline.find((item) => item.id === outlineRevealRequest.id) ?? null;
    if (viewMode !== "source" || splitMode) {
      if (outlineItem) {
        const heading = findMarkdownOutlineBlockHeading(bodyRef.current, outlineItem.blockId);
        if (heading) {
          heading.dataset.markdownOutlineId = outlineItem.id;
          heading.scrollIntoView?.(FILE_PREVIEW_REVEAL_SCROLL_OPTIONS);
        } else {
          markdownPreviewRef.current?.scrollToBlock(outlineItem.blockId, "start");
        }
      } else {
        const heading = findMarkdownOutlineHeading(bodyRef.current, outlineRevealRequest.id);
        if (heading) {
          heading.scrollIntoView?.(FILE_PREVIEW_REVEAL_SCROLL_OPTIONS);
        }
      }
    }
    if (viewMode === "preview" && !splitMode) {
      return;
    }
    setLineRevealRequest((current) => ({
      requestId: (current?.requestId ?? 0) + 1,
      position: sourcePositionForLine(formattedSource, outlineRevealRequest.line),
    }));
  }, [formattedSource, kind, markdownModel, outlineRevealRequest, splitMode, viewMode]);

  const findMode: FilePreviewFindMode = splitMode && canSplit
    ? "split"
    : viewMode === "source" || !canRenderPreview
      ? "source"
      : "preview";
  const markdownFindIndex = useMemo(
    () =>
      kind === "markdown" &&
      markdownModel &&
      findOpen &&
      findQuery.trim() &&
      (findMode === "preview" || findMode === "split")
        ? buildMarkdownFindIndex(markdownModel, findQuery)
        : null,
    [findMode, findOpen, findQuery, kind, markdownModel],
  );
  const markdownFindMatches = useMemo<MarkdownPreviewFindMatch[]>(
    () =>
      (markdownFindIndex?.matches ?? []).map((match) => ({
        blockId: match.blockId,
        id: match.id,
        sourceEnd: match.sourceEnd,
        sourceStart: match.sourceStart,
        type: "markdown",
      })),
    [markdownFindIndex],
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
    if (transientRevealAnnotationRef.current) {
      clearTransientReveal();
    }
  }, [activateFindRoot, clearTransientReveal]);

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
      if (!isFindShortcutEvent(event.nativeEvent)) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      openFind(event.target);
    },
    [openFind],
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
    const useDomMarkdownFind = kind === "markdown" && /\s/.test(findQuery);
    clearDomFindHighlights(bodyRef.current, {
      includeControlledMarks: kind !== "markdown" || useDomMarkdownFind || !findOpen || !findQuery.trim(),
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
    const domMatches = kind !== "markdown" || useDomMarkdownFind
      ? collectDomFindMatches(filePreviewFindContainers(bodyRef.current, findMode, Boolean(sourceEditorView)), findQuery)
      : [];
    const previewMarkdownMatches = useDomMarkdownFind ? [] : markdownFindMatches;
    const matches = mergeFilePreviewFindMatches(findMode, codeMirrorMatches, previewMarkdownMatches, domMatches);
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
        smoothScrollCodeMirrorPositionIntoView(sourceEditorView, activeCodeMirrorMatch.from, "center");
      }
    }
    if (shouldRecenterActiveMatch) {
      scrollFindMatchIntoView(activeMatch, markdownPreviewRef.current);
    }
  }, [findMatchIndex, findMode, findOpen, findQuery, kind, markdownFindMatches, renderedPreviewContent, sourceEditorView]);

  useEffect(() => () => clearDomFindHighlights(bodyRef.current, { includeControlledMarks: true }), []);

  const renderSourcePane = () => (
    <SourceViewer
      content={formattedSource}
      kind={kind}
      language={sourceLanguage(request, kind)}
      theme={theme}
      annotations={selectionAnnotations}
      activeAnnotationId={activeAnnotationId}
      flashAnnotationId={flashAnnotationId}
      revealLineRequest={lineRevealRequest}
      onAnnotationActivate={activateAnnotation}
      onEditorViewChange={setSourceEditorView}
      sourceFindState={sourceFindState}
      onSelectionChange={updateSourceSelection}
    />
  );

  const handleMarkdownPreviewClick = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      const target = event.target instanceof Element ? event.target : null;
      const marker = target?.closest<HTMLElement>("[data-preview-annotation-id]");
      const annotationId = marker?.dataset.previewAnnotationId;
      if (!annotationId || isTransientRevealAnnotationId(annotationId)) {
        return;
      }
      const annotation = annotations.find((item) => item.id === annotationId);
      if (!annotation) {
        return;
      }
      const rect = marker.getBoundingClientRect();
      event.preventDefault();
      event.stopPropagation();
      activateAnnotation(annotation, {
        clientX: rect.left + rect.width / 2,
        clientY: rect.top,
        width: rect.width,
        height: rect.height,
        anchorElement: marker,
      });
    },
    [activateAnnotation, annotations],
  );

  const renderPreviewPane = () => {
    if (kind === "mermaid") {
      return <NativeMermaidPreview code={renderedPreviewContent || ""} selectable />;
    }

    if (kind === "markdown") {
      if (!markdownModel || markdownModel.blocks.length === 0) {
        return (
          <PreviewScrollPane className={styles.markdownPane} data-file-preview-selectable-content="preview">
            <div className="keydex-markdown">
              <p>{markdownContent}</p>
            </div>
          </PreviewScrollPane>
        );
      }
      return (
        <PreviewScrollPane
          className={styles.markdownPane}
          data-file-preview-selectable-content="preview"
          onClick={handleMarkdownPreviewClick}
        >
          {(scrollElement) => (
            <VirtualMarkdownPreview
              ref={markdownPreviewRef}
              activeAnnotationId={activeAnnotationId}
              activeFindMatchId={activeMarkdownFindMatchId}
              annotationIndex={markdownAnnotationIndex}
              customScrollParent={scrollElement}
              findIndex={markdownFindIndex}
              flashAnnotationId={flashAnnotationId}
              model={markdownModel}
              registry={markdownRendererRegistry}
              renderImage={renderMarkdownImage}
              showSourceGutter
            />
          )}
        </PreviewScrollPane>
      );
    }

    if (kind === "html") {
      const htmlDocument = renderedPreviewContent || "<p>文件为空</p>";
      return (
        <PreviewScrollPane className={styles.htmlPane} data-file-preview-selectable-content="preview">
          <iframe
            key={hashText(htmlDocument)}
            className={styles.htmlFrame}
            title="HTML 文件预览"
            sandbox=""
            srcDoc={htmlDocument}
          />
        </PreviewScrollPane>
      );
    }

    if (kind === "diff") {
      return <DiffPreview diff={renderedPreviewContent || "暂无 diff"} />;
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
            <div className={styles.splitPanelBody}>{renderSourcePane()}</div>
          </section>
          <section className={styles.splitPanel} aria-label="渲染预览">
            <div className={styles.splitPanelHeader}>
              <Eye size={13} />
              <span>预览</span>
            </div>
            <div className={styles.splitPanelBody}>{renderPreviewPane()}</div>
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
            onClick={() => {
              setViewMode("preview");
              setSplitMode(false);
            }}
          >
            <Eye size={13} />
            <span>预览</span>
          </button>
          <button
            type="button"
            aria-pressed={viewMode === "source" && !splitMode}
            onClick={() => {
              setViewMode("source");
              setSplitMode(false);
            }}
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
          aria-label={`文件批注 ${annotations.length}`}
          aria-pressed={annotationPanelOpen && !annotationPanelClosing}
          title="文件批注"
          onClick={toggleAnnotationPanel}
        >
          <MessageSquareText size={13} />
          <span>批注</span>
          <span className={styles.annotationToggleCount}>{annotations.length}</span>
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
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  };

  return (
    <section
      className={styles.preview}
      data-chrome={chrome}
      data-file-preview-root="true"
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
        {renderActions()}
      </header>

      {previewBusy ? <FilePreviewLoading label="正在读取文件" /> : null}
      {error ? <div className={styles.error} role="alert">{error}</div> : null}
      {!previewBusy && !error ? (
        <div
          className={styles.body}
          data-chrome={chrome}
          data-workspace-document-context={isPathPreviewRequest(request) ? "true" : undefined}
          data-workspace-document-name={isPathPreviewRequest(request) ? fileName(request.path) : undefined}
          data-workspace-document-path={isPathPreviewRequest(request) ? request.path : undefined}
          data-workspace-id={workspaceId}
          data-workspace-session-id={sessionId}
          aria-label="预览内容"
          ref={bodyRef}
        >
          {renderBodyContent()}
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
          {selectionMappingError ? (
            <div
              className={styles.selectionAnnotationError}
              role="alert"
              data-file-preview-selection-excluded="true"
            >
              {selectionMappingError}
            </div>
          ) : null}
          {locateError ? (
            <div
              className={styles.selectionAnnotationError}
              role="alert"
              data-file-preview-selection-excluded="true"
            >
              {locateError}
            </div>
          ) : null}
          {activeAnnotation && activeAnnotationPopover ? (
            <AnnotationPopover
              annotation={activeAnnotation}
              canStartChat={Boolean(onStartChatFromAnnotation)}
              mutatingId={annotationMutatingId}
              position={activeAnnotationPopover}
              onClose={() => {
                setActiveAnnotationPopover(null);
                setFocusedAnnotationId(null);
              }}
              onDelete={deleteAnnotation}
              onSave={saveAnnotationComment}
              onStartChat={startChatFromAnnotation}
            />
          ) : null}
          {selectionDraft && selectionDraftPopover ? (
            <AnnotationDraftPopover
              draft={selectionDraft}
              error={annotationMutationError}
              mutating={annotationMutatingId === "create-selection"}
              position={selectionDraftPopover}
              onCancel={() => {
                setSelectionDraft(null);
                setSelectionDraftPopover(null);
                setAnnotationMutationError(null);
                setSelectionMappingError(null);
              }}
              onChange={setSelectionDraft}
              onCreate={createSelectionAnnotation}
            />
          ) : null}
          {annotationPath && (annotationPanelOpen || annotationPanelClosing) ? (
            <AnnotationPanel
              closing={annotationPanelClosing}
              annotations={annotations}
              loading={annotationsLoading}
              error={annotationError}
              unavailable={!annotationAvailable}
              fileDraft={fileAnnotationDraft}
              fileComposerOpen={fileAnnotationComposerOpen}
              fileComposerFocusRequestId={fileAnnotationComposerFocusRequestId}
              editingAnnotationId={editingAnnotationId}
              editingComment={editingComment}
              mutationError={annotationMutationError}
              mutatingId={annotationMutatingId}
              currentContentHash={currentContentHash}
              activeAnnotationId={activeAnnotationId}
              canStartChat={Boolean(onStartChatFromAnnotation)}
              onFileDraftChange={setFileAnnotationDraft}
              onFileComposerOpenChange={setFileAnnotationComposerOpen}
              onCreateFileAnnotation={createFileAnnotation}
              onBeginEdit={beginEditAnnotation}
              onEditingCommentChange={setEditingComment}
              onSaveEdit={saveAnnotationEdit}
              onCancelEdit={() => {
                setEditingAnnotationId(null);
                setEditingComment("");
              }}
              onDelete={deleteAnnotation}
              onStartChat={startChatFromAnnotation}
              onStartAllChats={startChatFromAllAnnotations}
              onReveal={revealAnnotation}
              onRetry={() => setAnnotationReloadId((current) => current + 1)}
              onClose={closeAnnotationPanel}
            />
          ) : null}
        </div>
      ) : null}
      {copyState === "failed" && !panelChrome ? <span className={styles.copyError}>复制失败</span> : null}
      {copyState === "copied" && !panelChrome ? <span className={styles.copyHint}>已复制</span> : null}
    </section>
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
  onQuote: (snapshot: FilePreviewSelectionSnapshot) => void;
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
    (selectedText: string) => onQuote(currentSnapshot(selectedText)),
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
      onQuote={quoteSelectionAvailable ? handleQuote : undefined}
      onAnnotate={annotationAvailable ? handleAnnotate : undefined}
      onClear={selection.clearSelection}
    />
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

const HIGHLIGHT_MAX_CHARS = 120_000;
const HIGHLIGHT_MAX_LINES = 2_000;
const FILE_PREVIEW_OPEN_SETTLE_MS = 260;
const MARKDOWN_MODEL_DEFER_CHARS = 48_000;
const MARKDOWN_MODEL_DEFER_MS = 260;
const ANNOTATION_PANEL_EXIT_MS = 160;
const ANNOTATION_FLASH_ITERATIONS = 1;
const ANNOTATION_FLASH_INTERVAL_MS = 700;
const ANNOTATION_FLASH_MS = ANNOTATION_FLASH_ITERATIONS * ANNOTATION_FLASH_INTERVAL_MS;
const ANNOTATION_POPOVER_ESTIMATED_HEIGHT = 190;
const ANNOTATION_POPOVER_GAP = 10;
const FILE_PREVIEW_SELECTION_EXCLUDE_SELECTOR = "[data-file-preview-selection-excluded='true']";
const FILE_PREVIEW_ANNOTATION_POPOVER_SELECTOR = "[data-file-preview-annotation-popover='true']";
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
const FILE_PREVIEW_TRANSIENT_REVEAL_SCROLL_OPTIONS: ScrollIntoViewOptions = {
  block: "center",
  inline: "nearest",
  behavior: "smooth",
};
const TRANSIENT_REVEAL_ANNOTATION_ID_PREFIX = "__file-preview-reveal:";

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

function scheduleMarkdownModelBuild(
  source: string,
  options: { deferLarge: boolean },
  build: () => void,
): () => void {
  let timer: number | null = null;
  let frame: number | null = null;

  if (!options.deferLarge || source.length <= MARKDOWN_MODEL_DEFER_CHARS) {
    build();
    return () => {};
  }

  const runAfterPaint = () => {
    frame = window.requestAnimationFrame(() => {
      frame = null;
      build();
    });
  };

  timer = window.setTimeout(() => {
    timer = null;
    runAfterPaint();
  }, MARKDOWN_MODEL_DEFER_MS);

  return () => {
    if (timer !== null) {
      window.clearTimeout(timer);
    }
    if (frame !== null) {
      window.cancelAnimationFrame(frame);
    }
  };
}

interface SelectionAnnotationDraft {
  anchor: WorkspaceFileAnnotationAnchorV2;
  selectedText: string;
  comment: string;
  lineStart: number | null;
  lineEnd: number | null;
  columnStart: number | null;
  columnEnd: number | null;
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

interface PreviewAnnotationRevealRequest {
  requestId: number;
  annotationId: string;
}

interface AnnotationPopoverState {
  annotationId: string;
  anchor: AnnotationPopoverAnchor;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface AnnotationDraftPopoverState {
  anchor: AnnotationPopoverAnchor;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface AnnotationClientPosition {
  clientX: number;
  clientY: number;
  width?: number;
  height?: number;
  anchorElement?: HTMLElement | null;
}

interface AnnotationPopoverAnchor {
  x: number;
  y: number;
  width: number;
  height: number;
  anchorElement: HTMLElement | null;
  scrollElement: HTMLElement | null;
  scrollLeft: number;
  scrollTop: number;
  windowScrollX: number;
  windowScrollY: number;
}

interface AnnotationPanelProps {
  closing: boolean;
  annotations: WorkspaceFileAnnotation[];
  loading: boolean;
  error: string | null;
  unavailable: boolean;
  fileDraft: string;
  fileComposerOpen: boolean;
  fileComposerFocusRequestId: number;
  editingAnnotationId: string | null;
  editingComment: string;
  mutationError: string | null;
  mutatingId: string | null;
  currentContentHash: string | null;
  activeAnnotationId: string | null;
  canStartChat: boolean;
  onFileDraftChange: (value: string) => void;
  onFileComposerOpenChange: (open: boolean) => void;
  onCreateFileAnnotation: () => void;
  onBeginEdit: (annotation: WorkspaceFileAnnotation) => void;
  onEditingCommentChange: (value: string) => void;
  onSaveEdit: (annotation: WorkspaceFileAnnotation) => void;
  onCancelEdit: () => void;
  onDelete: (annotation: WorkspaceFileAnnotation) => void;
  onStartChat: (annotation: WorkspaceFileAnnotation) => void;
  onStartAllChats: (annotations: WorkspaceFileAnnotation[]) => void;
  onReveal: (annotation: WorkspaceFileAnnotation) => void;
  onRetry: () => void;
  onClose: () => void;
}

function AnnotationPopover({
  annotation,
  canStartChat,
  mutatingId,
  position,
  onClose,
  onDelete,
  onSave,
  onStartChat,
}: {
  annotation: WorkspaceFileAnnotation;
  canStartChat: boolean;
  mutatingId: string | null;
  position: AnnotationPopoverState;
  onClose: () => void;
  onDelete: (annotation: WorkspaceFileAnnotation) => void;
  onSave: (annotation: WorkspaceFileAnnotation, value: string) => Promise<boolean>;
  onStartChat: (annotation: WorkspaceFileAnnotation) => void;
}) {
  const [comment, setComment] = useState(annotation.comment);
  useEffect(() => {
    setComment(annotation.comment);
  }, [annotation.comment, annotation.id]);
  const saving = mutatingId === `edit:${annotation.id}`;
  const deleting = mutatingId === `delete:${annotation.id}`;
  const changed = comment.trim() !== annotation.comment.trim();
  const placement = popoverPlacement(position);
  const style = popoverStyle(position, placement);
  const canSave = Boolean(comment.trim()) && changed && !saving;
  const saveCurrentComment = async () => {
    if (!canSave) {
      return;
    }
    const saved = await onSave(annotation, comment);
    if (saved) {
      onClose();
    }
  };

  return createPortal(
    <aside
      className={styles.annotationPopover}
      data-file-preview-annotation-popover="true"
      data-file-preview-selection-excluded="true"
      data-placement={placement}
      style={style}
      aria-label="选区批注"
    >
      <header className={styles.annotationPopoverHeader}>
        <span className={styles.annotationBadge}>{formatAnnotationBadge(annotation)}</span>
        <button type="button" title="关闭" aria-label="关闭选区批注浮窗" onClick={onClose}>
          <X size={12} />
        </button>
      </header>
      {annotation.selected_text ? (
        <blockquote className={styles.annotationPopoverQuote}>{annotation.selected_text}</blockquote>
      ) : null}
      <textarea
        className={styles.annotationPopoverTextarea}
        value={comment}
        rows={3}
        aria-label="编辑批注"
        onChange={(event) => setComment(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (!shouldConfirmAnnotationTextarea(event)) {
            return;
          }
          event.preventDefault();
          void saveCurrentComment();
        }}
      />
      <div className={styles.annotationPopoverActions} data-layout="annotation">
        <div className={styles.annotationPopoverActionGroup}>
          <button
            type="button"
            aria-label="删除批注"
            disabled={deleting}
            onClick={() => {
              onDelete(annotation);
              onClose();
            }}
          >
            <Trash2 className={styles.annotationPopoverDeleteIcon} size={12} />
            <span>删除</span>
          </button>
        </div>
        <div className={styles.annotationPopoverActionGroup}>
          <button
            type="button"
            disabled={!canSave}
            aria-label="保存批注"
            onClick={() => void saveCurrentComment()}
          >
            <Check size={12} />
            <span>{saving ? "保存中" : "保存"}</span>
          </button>
          <button
            type="button"
            disabled={!canStartChat}
            aria-label="基于此批注发起对话"
            onClick={() => {
              onStartChat(annotation);
              onClose();
            }}
          >
            <Send size={12} />
            <span>对话</span>
          </button>
          <button type="button" aria-label="关闭批注浮窗" onClick={onClose}>
            <X size={12} />
            <span>关闭</span>
          </button>
        </div>
      </div>
    </aside>,
    document.body,
  );
}

function AnnotationDraftPopover({
  draft,
  error,
  mutating,
  position,
  onCancel,
  onChange,
  onCreate,
}: {
  draft: SelectionAnnotationDraft;
  error: string | null;
  mutating: boolean;
  position: AnnotationDraftPopoverState;
  onCancel: () => void;
  onChange: (draft: SelectionAnnotationDraft) => void;
  onCreate: () => void;
}) {
  const placement = popoverPlacement(position);
  const style = popoverStyle(position, placement);
  const canCreate = Boolean(draft.comment.trim()) && !mutating;
  const createCurrentComment = () => {
    if (!canCreate) {
      return;
    }
    onCreate();
  };

  return createPortal(
    <aside
      className={styles.annotationPopover}
      data-file-preview-annotation-popover="true"
      data-file-preview-selection-excluded="true"
      data-placement={placement}
      style={style}
      aria-label="新增选区批注"
    >
      <header className={styles.annotationPopoverHeader}>
        <span className={styles.annotationBadge}>{formatAnnotationBadge(draft)}</span>
        <button type="button" aria-label="取消选区批注" onClick={onCancel}>
          <X size={12} />
        </button>
      </header>
      <blockquote className={styles.annotationPopoverQuote}>{draft.selectedText}</blockquote>
      <textarea
        className={styles.annotationPopoverTextarea}
        value={draft.comment}
        rows={3}
        placeholder="添加选区批注"
        aria-label="添加选区批注"
        autoFocus
        onChange={(event) => onChange({ ...draft, comment: event.currentTarget.value })}
        onKeyDown={(event) => {
          if (!shouldConfirmAnnotationTextarea(event)) {
            return;
          }
          event.preventDefault();
          createCurrentComment();
        }}
      />
      {error ? <p className={styles.annotationPopoverError}>{error}</p> : null}
      <div className={styles.annotationPopoverActions}>
        <button type="button" disabled={!canCreate} onClick={createCurrentComment}>
          <MessageSquarePlus size={12} />
          <span>{mutating ? "保存中" : "保存批注"}</span>
        </button>
        <button type="button" data-variant="ghost" onClick={onCancel}>
          取消
        </button>
      </div>
    </aside>,
    document.body,
  );
}

type AnnotationPopoverPlacement = "top" | "bottom";

function shouldConfirmAnnotationTextarea(event: ReactKeyboardEvent<HTMLTextAreaElement>): boolean {
  if (event.key !== "Enter" || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) {
    return false;
  }
  const nativeEvent = event.nativeEvent as globalThis.KeyboardEvent & { isComposing?: boolean; keyCode?: number };
  return !nativeEvent.isComposing && nativeEvent.keyCode !== 229;
}

function annotationChatRequest(annotation: WorkspaceFileAnnotation): PreviewAnnotationChatRequest {
  return {
    path: annotation.path,
    comment: annotation.comment,
    annotationId: annotation.id,
    selectedText: annotation.selected_text,
    lineStart: annotation.line_start,
    lineEnd: annotation.line_end,
    sourceStart: annotation.anchor_json?.sourceStart ?? null,
    sourceEnd: annotation.anchor_json?.sourceEnd ?? null,
  };
}

function createPopoverState(
  position: Pick<AnnotationPopoverState, "x" | "y" | "width" | "height">,
  anchorElement: HTMLElement | null,
  boundary: HTMLElement | null,
): Pick<AnnotationPopoverState, "anchor" | "x" | "y" | "width" | "height"> {
  const scrollElement = nearestScrollableAncestor(anchorElement, boundary);
  return {
    ...position,
    anchor: {
      ...position,
      anchorElement,
      scrollElement,
      scrollLeft: scrollElement?.scrollLeft ?? 0,
      scrollTop: scrollElement?.scrollTop ?? 0,
      windowScrollX: window.scrollX,
      windowScrollY: window.scrollY,
    },
  };
}

function repositionPopoverState<T extends Pick<AnnotationPopoverState, "anchor" | "x" | "y" | "width" | "height">>(
  state: T,
): T {
  const next = resolvePopoverPosition(state.anchor);
  if (
    Math.abs(next.x - state.x) < 0.5 &&
    Math.abs(next.y - state.y) < 0.5 &&
    next.width === state.width &&
    next.height === state.height
  ) {
    return state;
  }
  return { ...state, ...next };
}

function resolvePopoverPosition(anchor: AnnotationPopoverAnchor): Pick<AnnotationPopoverState, "x" | "y" | "width" | "height"> {
  if (anchor.anchorElement?.isConnected) {
    const rect = anchor.anchorElement.getBoundingClientRect();
    return {
      x: rect.left + rect.width / 2,
      y: rect.top,
      width: rect.width,
      height: rect.height,
    };
  }
  const scrollDeltaX = anchor.scrollElement ? anchor.scrollLeft - anchor.scrollElement.scrollLeft : 0;
  const scrollDeltaY = anchor.scrollElement ? anchor.scrollTop - anchor.scrollElement.scrollTop : 0;
  return {
    x: anchor.x + scrollDeltaX + anchor.windowScrollX - window.scrollX,
    y: anchor.y + scrollDeltaY + anchor.windowScrollY - window.scrollY,
    width: anchor.width,
    height: anchor.height,
  };
}

function currentSelectionElement(boundary: HTMLElement | null): HTMLElement | null {
  const selection = window.getSelection();
  if (!boundary || !selection || selection.rangeCount === 0) {
    return boundary;
  }
  const node = selection.getRangeAt(0).commonAncestorContainer;
  const element = node instanceof HTMLElement ? node : node.parentElement;
  return element && boundary.contains(element) ? element : boundary;
}

function nearestScrollableAncestor(element: HTMLElement | null, boundary: HTMLElement | null): HTMLElement | null {
  let current: HTMLElement | null = element;
  while (current) {
    if (isScrollableElement(current)) {
      return current;
    }
    if (current === boundary) {
      return null;
    }
    current = current.parentElement;
  }
  return null;
}

function isScrollableElement(element: HTMLElement): boolean {
  const style = window.getComputedStyle(element);
  const overflow = `${style.overflow} ${style.overflowX} ${style.overflowY}`;
  return /(auto|scroll|overlay)/.test(overflow) && (
    element.scrollHeight > element.clientHeight ||
    element.scrollWidth > element.clientWidth
  );
}

function popoverPlacement(position: Pick<AnnotationPopoverState, "y">): AnnotationPopoverPlacement {
  return position.y > ANNOTATION_POPOVER_ESTIMATED_HEIGHT + ANNOTATION_POPOVER_GAP ? "top" : "bottom";
}

function popoverStyle(
  position: Pick<AnnotationPopoverState, "x" | "y" | "height">,
  placement: AnnotationPopoverPlacement,
): CSSProperties {
  const top =
    placement === "bottom"
      ? position.y + Math.max(0, position.height) + ANNOTATION_POPOVER_GAP
      : position.y - ANNOTATION_POPOVER_GAP;
  return {
    left: `clamp(168px, ${position.x}px, calc(100vw - 168px))`,
    top: `${Math.max(ANNOTATION_POPOVER_GAP, top)}px`,
  };
}

function AnnotationPanel({
  closing,
  annotations,
  loading,
  error,
  unavailable,
  fileDraft,
  fileComposerOpen,
  fileComposerFocusRequestId,
  editingAnnotationId,
  editingComment,
  mutationError,
  mutatingId,
  currentContentHash,
  activeAnnotationId,
  canStartChat,
  onFileDraftChange,
  onFileComposerOpenChange,
  onCreateFileAnnotation,
  onBeginEdit,
  onEditingCommentChange,
  onSaveEdit,
  onCancelEdit,
  onDelete,
  onStartChat,
  onStartAllChats,
  onReveal,
  onRetry,
  onClose,
}: AnnotationPanelProps) {
  const creatingFile = mutatingId === "create-file";
  const fileDraftInputRef = useRef<HTMLTextAreaElement | null>(null);

  useLayoutEffect(() => {
    if (!fileComposerOpen) {
      return;
    }
    fileDraftInputRef.current?.focus();
  }, [fileComposerFocusRequestId, fileComposerOpen]);

  return (
    <aside
      className={styles.annotationPanel}
      data-file-preview-selection-excluded="true"
      data-state={closing ? "closing" : "open"}
      aria-label="文件批注"
    >
      <header className={styles.annotationHeader}>
        <span className={styles.annotationTitle}>
          <MessageSquareText size={14} />
          <span>批注</span>
        </span>
        <div className={styles.annotationHeaderActions}>
          <span className={styles.annotationCount}>{annotations.length}</span>
          <button type="button" className={styles.annotationClose} aria-label="关闭批注面板" onClick={onClose}>
            <X size={13} />
          </button>
        </div>
      </header>

      {unavailable ? <p className={styles.annotationMuted}>当前预览缺少工作区上下文，无法保存批注。</p> : null}

      {loading ? <p className={styles.annotationMuted}>正在加载批注</p> : null}
      {error ? (
        <div className={styles.annotationError} role="alert">
          <span>{error}</span>
          <button type="button" onClick={onRetry}>
            重试
          </button>
        </div>
      ) : null}
      {mutationError ? <div className={styles.annotationError}>{mutationError}</div> : null}

      {!loading && !error && annotations.length === 0 ? (
        <p className={styles.annotationEmpty}>暂无批注</p>
      ) : null}

      <div className={styles.annotationList}>
        {annotations.map((annotation) => {
          const editing = editingAnnotationId === annotation.id;
          const stale = isAnnotationStale(annotation, currentContentHash);
          const statusLabel = annotationAnchorStatusLabel(annotation, currentContentHash);
          return (
            <article
              className={styles.annotationItem}
              key={annotation.id}
              data-active={activeAnnotationId === annotation.id ? "true" : "false"}
              data-anchor-type={annotation.anchor_type}
              data-stale={stale ? "true" : "false"}
            >
              <div className={styles.annotationItemHeader}>
                {annotation.line_start ? (
                  <button
                    className={styles.annotationBadgeButton}
                    type="button"
                    title="定位到源码行"
                    onClick={() => onReveal(annotation)}
                  >
                    {formatAnnotationBadge(annotation)}
                  </button>
                ) : (
                  <span className={styles.annotationBadge}>{formatAnnotationBadge(annotation)}</span>
                )}
                {statusLabel ? <span className={styles.annotationStale}>{statusLabel}</span> : null}
              </div>

              {annotation.selected_text ? (
                <blockquote className={styles.annotationQuote}>{annotation.selected_text}</blockquote>
              ) : null}

              {editing ? (
                <div className={styles.annotationEdit}>
                  <textarea
                    value={editingComment}
                    rows={3}
                    aria-label="编辑批注"
                    onChange={(event) => onEditingCommentChange(event.currentTarget.value)}
                  />
                  <div className={styles.annotationComposerActions}>
                    <button
                      type="button"
                      disabled={!editingComment.trim() || mutatingId === `edit:${annotation.id}`}
                      onClick={() => onSaveEdit(annotation)}
                    >
                      保存
                    </button>
                    <button type="button" data-variant="ghost" onClick={onCancelEdit}>
                      取消
                    </button>
                  </div>
                </div>
              ) : (
                <p className={styles.annotationComment}>{annotation.comment}</p>
              )}

              <div className={styles.annotationActions}>
                {annotation.selected_text ? (
                  <button
                    type="button"
                    title="定位批注片段"
                    aria-label="定位批注片段"
                    onClick={() => onReveal(annotation)}
                  >
                    <Target size={13} />
                  </button>
                ) : null}
                <button
                  type="button"
                  disabled={!canStartChat}
                  title="发起对话"
                  aria-label="基于此批注发起对话"
                  onClick={() => {
                    onStartChat(annotation);
                    onClose();
                  }}
                >
                  <Send size={13} />
                </button>
                <button
                  type="button"
                  title="编辑批注"
                  aria-label="编辑批注"
                  onClick={() => onBeginEdit(annotation)}
                >
                  <Pencil size={13} />
                </button>
                <button
                  type="button"
                  title="删除批注"
                  aria-label="删除批注"
                  disabled={mutatingId === `delete:${annotation.id}`}
                  onClick={() => onDelete(annotation)}
                >
                  <Trash2 size={13} />
                </button>
              </div>
            </article>
          );
        })}
      </div>

      {!unavailable ? (
        <div className={styles.annotationFooter}>
          {annotations.length ? (
            <button
              type="button"
              className={styles.annotationBulkChatButton}
              disabled={!canStartChat}
              onClick={() => {
                onStartAllChats(annotations);
                onClose();
              }}
            >
              <Send size={13} />
              <span>全部添加到对话</span>
            </button>
          ) : null}

          {!fileComposerOpen ? (
            <button type="button" className={styles.annotationAddButton} onClick={() => onFileComposerOpenChange(true)}>
              <MessageSquarePlus size={13} />
              <span>添加文件批注</span>
            </button>
          ) : null}

          {fileComposerOpen ? (
            <div className={styles.annotationComposer}>
              <textarea
                ref={fileDraftInputRef}
                value={fileDraft}
                rows={2}
                placeholder="添加文件级批注"
                aria-label="添加文件级批注"
                onChange={(event) => onFileDraftChange(event.currentTarget.value)}
              />
              <div className={styles.annotationComposerActions}>
                <button
                  type="button"
                  disabled={!fileDraft.trim() || creatingFile}
                  onClick={() => {
                    onCreateFileAnnotation();
                    onFileComposerOpenChange(false);
                  }}
                >
                  <MessageSquarePlus size={13} />
                  <span>{creatingFile ? "保存中" : "添加文件批注"}</span>
                </button>
                <button type="button" data-variant="ghost" onClick={() => onFileComposerOpenChange(false)}>
                  取消
                </button>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </aside>
  );
}

function selectionAnchorFromCurrentSelection(
  source: string,
  createdInView: WorkspaceFileAnnotationAnchorV2["createdInView"],
  selectedText: string,
  sourceSelection: SourceSelection | null,
  selectionRange: Range | null,
  boundary: HTMLElement | null,
): WorkspaceFileAnnotationAnchorV2 | null {
  const sourceRange = matchingSourceSelection(sourceSelection, selectedText, selectionRange, boundary);
  if (sourceRange) {
    return createSourceRangeAnchor(source, sourceRange.sourceStart, sourceRange.sourceEnd, "source", selectedText);
  }
  if (!selectionRange || !boundary || !boundary.contains(selectionRange.commonAncestorContainer)) {
    return null;
  }
  const previewRange = previewSourceRangeFromSelection(selectionRange, boundary);
  return previewRange
    ? createSourceRangeAnchor(source, previewRange.sourceStart, previewRange.sourceEnd, createdInView, selectedText)
    : null;
}

function matchingSourceSelection(
  sourceSelection: SourceSelection | null,
  selectedText: string,
  selectionRange: Range | null,
  boundary: HTMLElement | null,
): SourceSelection | null {
  if (!sourceSelection || !selectionRange || !boundary) {
    return null;
  }
  const startElement = selectionRange.startContainer instanceof Element
    ? selectionRange.startContainer
    : selectionRange.startContainer.parentElement;
  const sourceViewer = startElement?.closest("[data-testid='file-source-viewer']");
  if (!sourceViewer || !boundary.contains(sourceViewer)) {
    return null;
  }
  return normalizeSelectionText(sourceSelection.selectedText) === normalizeSelectionText(selectedText)
    ? sourceSelection
    : null;
}

function previewSourceRangeFromSelection(
  selectionRange: Range,
  boundary: HTMLElement,
): { sourceStart: number; sourceEnd: number } | null {
  const allSegments = Array.from(
    boundary.querySelectorAll<HTMLElement>("[data-preview-source-start][data-preview-source-end]"),
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
    const segmentStart = dataInteger(segment.dataset.previewSourceStart);
    const segmentEnd = dataInteger(segment.dataset.previewSourceEnd);
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
  const segment = element?.closest<HTMLElement>("[data-preview-source-start][data-preview-source-end]") ?? null;
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

function formatAnnotationBadge(
  annotation: Pick<WorkspaceFileAnnotation, "anchor_type" | "line_start" | "line_end"> | SelectionAnnotationDraft,
): string {
  if ("anchor_type" in annotation && annotation.anchor_type === "file") {
    return "文件";
  }
  if ("lineStart" in annotation && annotation.lineStart && annotation.lineEnd) {
    return annotation.lineStart === annotation.lineEnd
      ? `L${annotation.lineStart}`
      : `L${annotation.lineStart}-L${annotation.lineEnd}`;
  }
  if ("line_start" in annotation && annotation.line_start && annotation.line_end) {
    return annotation.line_start === annotation.line_end
      ? `L${annotation.line_start}`
      : `L${annotation.line_start}-L${annotation.line_end}`;
  }
  return "选区";
}

function isAnnotationStale(annotation: WorkspaceFileAnnotation, currentContentHash: string | null): boolean {
  return Boolean(annotation.content_hash && currentContentHash && annotation.content_hash !== currentContentHash);
}

function annotationAnchorStatusLabel(
  annotation: WorkspaceFileAnnotation,
  currentContentHash: string | null,
): string | null {
  if (annotation.anchor_type !== "selection") {
    return null;
  }
  if (!annotation.anchor_json) {
    return "无法定位";
  }
  if (isAnnotationStale(annotation, currentContentHash)) {
    return "内容可能已变化";
  }
  return null;
}

function findAnnotationElement(container: HTMLElement | null, annotationId: string): HTMLElement | null {
  if (!container) {
    return null;
  }
  const elements = container.querySelectorAll<HTMLElement>("[data-preview-annotation-id], [data-file-annotation-id]");
  return Array.from(elements).find(
    (element) =>
      element.dataset.previewAnnotationId === annotationId ||
      element.dataset.fileAnnotationId === annotationId,
  ) ?? null;
}

function findPreviewAnnotationElement(container: HTMLElement | null, annotationId: string): HTMLElement | null {
  if (!container) {
    return null;
  }
  const elements = container.querySelectorAll<HTMLElement>("[data-preview-annotation-id]");
  return Array.from(elements).find((element) => element.dataset.previewAnnotationId === annotationId) ?? null;
}

function findMarkdownOutlineHeading(container: HTMLElement | null, headingId: string): HTMLElement | null {
  if (!container) {
    return null;
  }
  const elements = container.querySelectorAll<HTMLElement>("[data-markdown-outline-id]");
  return Array.from(elements).find((element) => element.dataset.markdownOutlineId === headingId) ?? null;
}

function findMarkdownOutlineBlockHeading(container: HTMLElement | null, blockId: string): HTMLElement | null {
  if (!container) {
    return null;
  }
  return container.querySelector<HTMLElement>(`[data-markdown-outline-block-id='${cssString(blockId)}']`);
}

function updatePreviewAnnotationMarkState(
  container: HTMLElement | null,
  activeAnnotationId: string | null,
  flashAnnotationId: string | null,
): void {
  if (!container) {
    return;
  }
  container.querySelectorAll<HTMLElement>("[data-preview-annotation-id]").forEach((element) => {
    const annotationId = element.dataset.previewAnnotationId ?? null;
    element.dataset.active = annotationId && annotationId === activeAnnotationId ? "true" : "false";
    element.dataset.flash = annotationId && annotationId === flashAnnotationId ? "true" : "false";
  });
}

function isAbortError(reason: unknown): boolean {
  return reason instanceof DOMException && reason.name === "AbortError";
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

function transientRevealAnnotationFromRequest(
  source: string,
  path: string,
  request: FilePreviewRevealRequest,
  scope: WorkspaceScope | null,
): WorkspaceFileAnnotation | null {
  const range = sourceRangeFromRevealRequest(source, request);
  if (!range) {
    return null;
  }
  const selectedText =
    typeof request.selectedText === "string" && request.selectedText.trim()
      ? request.selectedText.trim()
      : source.slice(range.from, range.to).trim();
  if (!selectedText) {
    return null;
  }
  try {
    const anchor = createSourceRangeAnchor(source, range.from, range.to, "source", selectedText);
    const workspaceId = scope && "workspaceId" in scope ? scope.workspaceId ?? "" : "";
    const sessionId = scope && "sessionId" in scope ? scope.sessionId ?? "" : "";
    return {
      id: `${TRANSIENT_REVEAL_ANNOTATION_ID_PREFIX}${request.requestId}`,
      scope_type: workspaceId ? "workspace" : "session",
      scope_id: workspaceId || sessionId,
      workspace_id: workspaceId || null,
      path,
      anchor_type: "selection",
      comment: "跳转定位",
      selected_text: selectedText,
      line_start: anchor.lineStart,
      line_end: anchor.lineEnd,
      column_start: anchor.columnStart,
      column_end: anchor.columnEnd,
      content_hash: anchor.contentHash,
      anchor_json: anchor,
      created_at: "",
      updated_at: "",
    };
  } catch {
    return null;
  }
}

function sourceRangeFromRevealRequest(
  source: string,
  request: PreviewFileRevealTarget,
): Pick<AnnotationTextRange, "from" | "to"> | null {
  const lineRange =
    positiveInteger(request.lineStart) && positiveInteger(request.lineEnd)
      ? sourceRangeForLines(source, request.lineStart, request.lineEnd)
      : null;
  if (lineRange) {
    return lineRange;
  }
  if (nonNegativeInteger(request.sourceStart) && positiveInteger(request.sourceEnd)) {
    return normalizeOffsetRange(source, request.sourceStart, request.sourceEnd);
  }
  return null;
}

function sourceRangeForLines(
  source: string,
  lineStart: number,
  lineEnd: number,
): Pick<AnnotationTextRange, "from" | "to"> | null {
  const fromLine = Math.min(lineStart, lineEnd);
  const toLine = Math.max(lineStart, lineEnd);
  const from = sourcePositionForLine(source, fromLine);
  let to = sourcePositionForLine(source, toLine + 1);
  while (to > from && (source.charCodeAt(to - 1) === 10 || source.charCodeAt(to - 1) === 13)) {
    to -= 1;
  }
  return normalizeOffsetRange(source, from, to);
}

function isTransientRevealAnnotationId(annotationId: string | null | undefined): boolean {
  return Boolean(annotationId?.startsWith(TRANSIENT_REVEAL_ANNOTATION_ID_PREFIX));
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
  markdownPreview: VirtualMarkdownPreviewHandle | null,
): void {
  if (match?.type === "dom") {
    match.element.scrollIntoView?.(FILE_PREVIEW_FIND_SCROLL_OPTIONS);
    return;
  }
  if (match?.type === "markdown") {
    scrollMarkdownFindMatchIntoView(match.id, markdownPreview);
    return;
  }
  if (match?.type === "split") {
    scrollMarkdownFindMatchIntoView(match.markdown.id, markdownPreview);
  }
}

function scrollMarkdownFindMatchIntoView(
  matchId: string,
  markdownPreview: VirtualMarkdownPreviewHandle | null,
): void {
  if (scrollMarkdownFindMarkerIntoView(matchId)) {
    return;
  }
  if (!markdownPreview?.scrollToFindMatch(matchId, "center")) {
    return;
  }
  window.requestAnimationFrame(() => scrollMarkdownFindMarkerIntoView(matchId));
  window.setTimeout(() => scrollMarkdownFindMarkerIntoView(matchId), 80);
}

function scrollMarkdownFindMarkerIntoView(matchId: string): boolean {
  const marker = document.querySelector<HTMLElement>(`[data-find-match-id='${cssString(matchId)}']`);
  marker?.scrollIntoView?.(FILE_PREVIEW_FIND_SCROLL_OPTIONS);
  return Boolean(marker);
}

const SourceViewer = memo(function SourceViewer({
  content,
  kind,
  language,
  theme,
  annotations = [],
  activeAnnotationId = null,
  flashAnnotationId = null,
  revealLineRequest,
  onAnnotationActivate,
  onEditorViewChange,
  sourceFindState,
  onSelectionChange,
}: {
  content: string;
  kind: PreviewKind;
  language: string;
  theme: "light" | "dark";
  annotations?: WorkspaceFileAnnotation[];
  activeAnnotationId?: string | null;
  flashAnnotationId?: string | null;
  revealLineRequest?: SourceLineRevealRequest | null;
  onAnnotationActivate?: (annotation: WorkspaceFileAnnotation, position: AnnotationClientPosition) => void;
  onEditorViewChange?: (view: EditorView | null) => void;
  sourceFindState?: CodeMirrorFindState | null;
  onSelectionChange?: (selection: SourceSelection | null) => void;
}) {
  const source = content || "文件为空";
  const lineCount = useMemo(() => countLines(source), [source]);
  const canHighlight =
    kind === "code" ||
    kind === "markdown" ||
    kind === "html" ||
    kind === "json" ||
    kind === "mermaid" ||
    kind === "diff";
  const shouldHighlight =
    canHighlight && source.length <= HIGHLIGHT_MAX_CHARS && lineCount <= HIGHLIGHT_MAX_LINES;
  const highlightSignature = useMemo(
    () => `${kind}\0${language}\0${source.length}\0${hashText(source)}`,
    [kind, language, source],
  );
  const [failedCodeMirrorSignature, setFailedCodeMirrorSignature] = useState<string | null>(null);
  const codeMirrorFailed = failedCodeMirrorSignature === highlightSignature;

  useEffect(() => {
    if (!shouldHighlight || codeMirrorFailed) {
      onSelectionChange?.(null);
    }
  }, [codeMirrorFailed, onSelectionChange, shouldHighlight]);

  const handleCodeMirrorCreateError = useCallback(() => {
    setFailedCodeMirrorSignature(highlightSignature);
  }, [highlightSignature]);

  if (shouldHighlight && !codeMirrorFailed) {
    return (
      <div className={styles.sourceViewer} data-renderer="codemirror" data-testid="file-source-viewer">
        <CodeMirrorSourceView
          language={language}
          source={source}
          theme={theme}
          annotations={annotations}
          activeAnnotationId={activeAnnotationId}
          flashAnnotationId={flashAnnotationId}
          revealLineRequest={revealLineRequest}
          onAnnotationActivate={onAnnotationActivate}
          onEditorViewChange={onEditorViewChange}
          sourceFindState={sourceFindState}
          onSelectionChange={onSelectionChange}
          onCreateError={handleCodeMirrorCreateError}
        />
      </div>
    );
  }

  return <PlainSourceView source={source} lineCount={lineCount} />;
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
  language,
  source,
  theme,
  annotations,
  activeAnnotationId,
  flashAnnotationId,
  revealLineRequest,
  onAnnotationActivate,
  onEditorViewChange,
  sourceFindState,
  onSelectionChange,
  onCreateError,
}: {
  language: string;
  source: string;
  theme: "light" | "dark";
  annotations: WorkspaceFileAnnotation[];
  activeAnnotationId: string | null;
  flashAnnotationId: string | null;
  revealLineRequest?: SourceLineRevealRequest | null;
  onAnnotationActivate?: (annotation: WorkspaceFileAnnotation, position: AnnotationClientPosition) => void;
  onEditorViewChange?: (view: EditorView | null) => void;
  sourceFindState?: CodeMirrorFindState | null;
  onSelectionChange?: (selection: SourceSelection | null) => void;
  onCreateError?: (error: unknown) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onSelectionChangeRef = useRef(onSelectionChange);
  const themeCompartmentRef = useRef<Compartment | null>(null);
  const languageCompartmentRef = useRef<Compartment | null>(null);
  const annotationCompartmentRef = useRef<Compartment | null>(null);
  const findCompartmentRef = useRef<Compartment | null>(null);
  const [scrollElement, setScrollElement] = useState<HTMLElement | null>(null);
  if (themeCompartmentRef.current === null) {
    themeCompartmentRef.current = new Compartment();
  }
  if (languageCompartmentRef.current === null) {
    languageCompartmentRef.current = new Compartment();
  }
  if (annotationCompartmentRef.current === null) {
    annotationCompartmentRef.current = new Compartment();
  }
  if (findCompartmentRef.current === null) {
    findCompartmentRef.current = new Compartment();
  }
  const themeCompartment = themeCompartmentRef.current;
  const languageCompartment = languageCompartmentRef.current;
  const annotationCompartment = annotationCompartmentRef.current;
  const findCompartment = findCompartmentRef.current;

  useEffect(() => {
    onSelectionChangeRef.current = onSelectionChange;
  }, [onSelectionChange]);

  const selectionExtension = useMemo(
    () =>
      EditorView.updateListener.of((update) => {
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
          doc: source,
          extensions: [
            ...codeMirrorBaseExtensions(),
            selectionExtension,
            themeCompartment.of(codeMirrorTheme(theme)),
            languageCompartment.of(codeMirrorLanguage(language) ?? []),
            annotationCompartment.of(
              codeMirrorAnnotationExtension(
                source,
                annotations,
                activeAnnotationId,
                flashAnnotationId,
                onAnnotationActivate,
              ),
            ),
            findCompartment.of(codeMirrorFindExtension(source, sourceFindState ?? null)),
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
    setScrollElement(view.scrollDOM);
    onEditorViewChange?.(view);

    return () => {
      if (viewRef.current === view) {
        viewRef.current = null;
      }
      setScrollElement(null);
      onEditorViewChange?.(null);
      onSelectionChangeRef.current?.(null);
      view.destroy();
    };
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) {
      return;
    }
    const currentSource = view.state.doc.toString();
    if (currentSource === source) {
      return;
    }
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: source },
    });
  }, [source]);

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
      effects: annotationCompartment.reconfigure(
        codeMirrorAnnotationExtension(source, annotations, activeAnnotationId, flashAnnotationId, onAnnotationActivate),
      ),
    });
  }, [activeAnnotationId, annotationCompartment, annotations, flashAnnotationId, onAnnotationActivate, source]);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: findCompartment.reconfigure(codeMirrorFindExtension(source, sourceFindState ?? null)),
    });
  }, [findCompartment, source, sourceFindState]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || !revealLineRequest) {
      return;
    }
    const position = Math.max(0, Math.min(revealLineRequest.position, view.state.doc.length));
    smoothScrollCodeMirrorPositionIntoView(view, position, revealLineRequest.block ?? "start");
  }, [revealLineRequest]);

  return (
    <div className={styles.codeMirrorShell}>
      <div ref={hostRef} className={styles.codeMirrorHost} />
      <FilePreviewScrollRail
        scrollElement={scrollElement}
        observeSelector=".cm-content"
        railTestId="source-scroll-rail"
        surface="source"
        thumbTestId="source-scroll-thumb"
      />
    </div>
  );
}

function PreviewScrollPane({
  children,
  className,
  ...props
}: PreviewScrollPaneProps) {
  const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null);
  const setScrollRef = useCallback((element: HTMLDivElement | null) => {
    setScrollElement(element);
  }, []);
  const resolvedChildren = typeof children === "function" ? (scrollElement ? children(scrollElement) : null) : children;

  return (
    <div className={styles.previewScrollShell}>
      <div ref={setScrollRef} className={className} data-custom-scrollbar="true" {...props}>
        {resolvedChildren}
      </div>
      <FilePreviewScrollRail
        scrollElement={scrollElement}
        railTestId="preview-scroll-rail"
        surface="preview"
        thumbTestId="preview-scroll-thumb"
      />
    </div>
  );
}

interface PreviewScrollPaneProps extends Omit<HTMLAttributes<HTMLDivElement>, "children"> {
  className: string;
  children: ReactNode | ((scrollElement: HTMLElement | null) => ReactNode);
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
      current.visible === next.visible &&
      Math.abs(current.thumbTop - next.thumbTop) < 0.5 &&
      Math.abs(current.thumbHeight - next.thumbHeight) < 0.5
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
    const startedOnThumb = Boolean(thumb);
    if (!startedOnThumb) {
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
      className={styles.previewScrollRail}
      data-surface={surface}
      data-visible={metrics.visible ? "true" : "false"}
      data-testid={railTestId}
      aria-hidden="true"
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

function smoothScrollCodeMirrorPositionIntoView(
  view: EditorView,
  position: number,
  block: ScrollLogicalPosition = "start",
): void {
  view.requestMeasure({
    read() {
      const line = view.lineBlockAt(position);
      return {
        height: line.height,
        top: Math.max(0, line.top),
      };
    },
    write(line) {
      const centeredTop = line.top - Math.max(0, (view.scrollDOM.clientHeight - line.height) / 2);
      const top = block === "center" ? Math.max(0, centeredTop) : line.top;
      if (typeof view.scrollDOM.scrollTo === "function") {
        view.scrollDOM.scrollTo({ top, behavior: "smooth" });
        return;
      }
      view.scrollDOM.scrollTop = top;
    },
  });
}

function codeMirrorAnnotationExtension(
  source: string,
  annotations: WorkspaceFileAnnotation[],
  activeAnnotationId: string | null,
  flashAnnotationId: string | null,
  onAnnotationActivate?: (annotation: WorkspaceFileAnnotation, position: AnnotationClientPosition) => void,
): Extension {
  const decorationRanges = annotationDecorationRanges(source, annotations).map(({ annotation, from, to }) =>
    Decoration.mark({
      class: "cm-fileAnnotationMark",
      attributes: {
        "data-file-annotation-id": annotation.id,
        "data-active": activeAnnotationId === annotation.id ? "true" : "false",
        "data-flash": flashAnnotationId === annotation.id ? "true" : "false",
        "data-transient-reveal": isTransientRevealAnnotationId(annotation.id) ? "true" : "false",
        title: annotation.comment,
      },
    }).range(from, to),
  );
  const decorations: DecorationSet = Decoration.set(decorationRanges, true);

  return [
    EditorView.decorations.of(decorations),
    EditorView.domEventHandlers({
      click(event) {
        const target = event.target instanceof Element ? event.target : null;
        const marker = target?.closest<HTMLElement>("[data-file-annotation-id]");
        const annotationId = marker?.dataset.fileAnnotationId;
        if (!annotationId) {
          return false;
        }
        const annotation = annotations.find((item) => item.id === annotationId);
        if (!annotation) {
          return false;
        }
        const rect = marker.getBoundingClientRect();
        event.preventDefault();
        event.stopPropagation();
        onAnnotationActivate?.(annotation, {
          clientX: rect.left + rect.width / 2,
          clientY: rect.top,
          width: rect.width,
          height: rect.height,
          anchorElement: marker,
        });
        return true;
      },
    }),
  ];
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

function annotationDecorationRanges(source: string, annotations: WorkspaceFileAnnotation[]): AnnotationTextRange[] {
  return annotations
    .map((annotation) => {
      const range = annotationSourceRange(source, annotation);
      return range ? { annotation, ...range } : null;
    })
    .filter((range): range is AnnotationTextRange => Boolean(range));
}

interface AnnotationTextRange {
  annotation: WorkspaceFileAnnotation;
  from: number;
  to: number;
}

function annotationSourceRange(
  source: string,
  annotation: WorkspaceFileAnnotation,
): Pick<AnnotationTextRange, "from" | "to"> | null {
  const validation = validateSourceRangeAnchor(source, annotation.anchor_json);
  return validation.valid && validation.anchor
    ? { from: validation.anchor.sourceStart, to: validation.anchor.sourceEnd }
    : null;
}

function normalizeOffsetRange(
  source: string,
  from: number,
  to: number,
): Pick<AnnotationTextRange, "from" | "to"> | null {
  const start = Math.max(0, Math.min(from, source.length));
  const end = Math.max(start, Math.min(to, source.length));
  return end > start ? { from: start, to: end } : null;
}

function positiveInteger(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function nonNegativeInteger(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
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
    EditorState.readOnly.of(true),
    EditorView.lineWrapping,
    keymap.of(foldKeymap),
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    syntaxHighlighting(codeMirrorHighlightStyle, { fallback: true }),
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
        fontSize: "12px",
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
        padding: "0 24px 0 14px",
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
      ".cm-fileAnnotationMark": {
        borderBottom: "1px solid color-mix(in srgb, var(--color-warning) 70%, transparent)",
        backgroundColor: "color-mix(in srgb, var(--color-warning) 18%, transparent)",
        borderRadius: "3px",
        cursor: "pointer",
        transition:
          "background-color var(--motion-fast) var(--motion-ease-standard), box-shadow var(--motion-fast) var(--motion-ease-standard)",
      },
      ".cm-fileAnnotationMark:hover, .cm-fileAnnotationMark[data-active='true']": {
        backgroundColor: "color-mix(in srgb, var(--color-warning) 30%, transparent)",
        boxShadow: "0 0 0 1px color-mix(in srgb, var(--color-warning) 46%, transparent)",
      },
      ".cm-fileAnnotationMark[data-flash='true']": {
        animation: "annotationMarkFlash 700ms var(--motion-ease-out) 1 both",
        backgroundColor: "color-mix(in srgb, var(--color-warning) 52%, transparent)",
        boxShadow: "0 0 0 3px color-mix(in srgb, var(--color-warning) 22%, transparent)",
      },
      ".cm-fileAnnotationMark[data-transient-reveal='true']": {
        backgroundColor: "rgb(250 204 21 / 42%)",
        borderBottom: "1px solid rgb(234 179 8 / 72%)",
        boxShadow: "0 0 0 1px rgb(234 179 8 / 28%)",
        cursor: "default",
      },
      ".cm-fileAnnotationMark[data-transient-reveal='true'][data-active='true']": {
        backgroundColor: "rgb(250 204 21 / 66%)",
        boxShadow:
          "0 0 0 2px color-mix(in srgb, var(--color-text-primary) 44%, transparent), 0 0 0 5px rgb(250 204 21 / 26%), inset 0 -2px 0 rgb(234 179 8 / 88%)",
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
  { tag: tags.keyword, color: "#7c3aed", fontWeight: "600" },
  { tag: [tags.atom, tags.bool, tags.special(tags.variableName)], color: "#2563eb" },
  { tag: [tags.number, tags.integer, tags.float], color: "#0f766e" },
  { tag: [tags.string, tags.special(tags.string)], color: "#15803d" },
  { tag: tags.regexp, color: "#be123c" },
  { tag: [tags.comment, tags.docComment], color: "var(--color-text-tertiary)", fontStyle: "italic" },
  { tag: tags.variableName, color: "var(--color-text-primary)" },
  { tag: [tags.definition(tags.variableName), tags.function(tags.variableName)], color: "#0f68a8" },
  { tag: [tags.className, tags.typeName, tags.namespace], color: "#b45309" },
  { tag: [tags.propertyName, tags.attributeName], color: "#1d4ed8" },
  { tag: tags.operator, color: "#9333ea" },
  { tag: [tags.punctuation, tags.bracket, tags.squareBracket, tags.paren, tags.brace], color: "var(--color-text-tertiary)" },
  { tag: [tags.heading, tags.strong], fontWeight: "700", color: "var(--color-text-primary)" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.link, color: "var(--color-accent)", textDecoration: "underline" },
]);

function PathBreadcrumbs({ path, rootLabel }: { path: string; rootLabel?: string }) {
  const pathSegments = path.split(/[\\/]/).filter(Boolean);
  const rootSegment = rootLabel ? fileName(rootLabel) : "";
  const displaySegments = [
    ...(rootSegment && pathSegments[0] !== rootSegment ? [rootSegment] : []),
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
  code,
  layout = "panel",
  selectable = false,
}: {
  code: string;
  layout?: "panel" | "document" | "fullscreen";
  selectable?: boolean;
}) {
  const [theme, setTheme] = useState<"light" | "dark">(() => getTheme());
  const [state, setState] = useState<MermaidPreviewState>({ status: "loading" });
  const [scale, setScale] = useState(1);
  const [fullscreenOpen, setFullscreenOpen] = useState(false);
  const [mermaidCopyState, setMermaidCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const viewportRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<MermaidDragState | null>(null);
  const mermaidCopyTimerRef = useRef<number | null>(null);
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
    setMermaidCopyState("idle");
  }, [code]);

  useEffect(() => () => {
    if (mermaidCopyTimerRef.current !== null) {
      window.clearTimeout(mermaidCopyTimerRef.current);
      mermaidCopyTimerRef.current = null;
    }
  }, []);

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
    if (mermaidCopyTimerRef.current !== null) {
      window.clearTimeout(mermaidCopyTimerRef.current);
      mermaidCopyTimerRef.current = null;
    }
    try {
      await copyText(code);
      setMermaidCopyState("copied");
    } catch {
      setMermaidCopyState("failed");
    }
    mermaidCopyTimerRef.current = window.setTimeout(() => {
      setMermaidCopyState("idle");
      mermaidCopyTimerRef.current = null;
    }, 1400);
  }, [code]);

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
  const scrollParent = viewport.closest<HTMLElement>("[data-custom-scrollbar='true']");
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

function annotationWorkspaceScope({
  workspaceId,
  sessionId,
}: {
  workspaceId?: string;
  sessionId?: string;
}): WorkspaceScope | null {
  if (workspaceId) {
    return { workspaceId };
  }
  if (sessionId) {
    return { sessionId };
  }
  return null;
}

function isWorkspaceFileAnnotationRequestForPreview(
  detail: StartWorkspaceFileAnnotationDetail,
  annotationPath: string,
  workspaceId?: string,
  sessionId?: string,
): boolean {
  return (
    detail.path === annotationPath &&
    workspaceContextValueMatches(detail.workspaceId, workspaceId) &&
    workspaceContextValueMatches(detail.sessionId, sessionId)
  );
}

function workspaceContextValueMatches(
  requestValue: string | null | undefined,
  previewValue: string | null | undefined,
): boolean {
  const normalizedRequestValue = requestValue?.trim() || null;
  if (!normalizedRequestValue) {
    return true;
  }
  return normalizedRequestValue === (previewValue?.trim() || null);
}

function annotationWorkspaceRuntime(runtime: RuntimeBridge | undefined): AnnotationWorkspaceRuntime | null {
  const workspace = runtime?.workspace as Partial<RuntimeBridge["workspace"]> | undefined;
  if (
    typeof workspace?.listAnnotations !== "function" ||
    typeof workspace.createAnnotation !== "function" ||
    typeof workspace.updateAnnotation !== "function" ||
    typeof workspace.deleteAnnotation !== "function"
  ) {
    return null;
  }
  return workspace as AnnotationWorkspaceRuntime;
}

function DiffPreview({ diff }: { diff: string }) {
  const lines = parseUnifiedDiffDisplayLines(diff);
  return (
    <PreviewScrollPane className={styles.diffPane} aria-label="Diff 渲染内容">
      {lines.map((line) => (
        <div key={line.key} className={styles.diffLine} data-kind={line.kind}>
          <span className={styles.diffLineNo}>{line.lineNumber ?? ""}</span>
          <code>
            {line.sign}
            {line.content || " "}
          </code>
        </div>
      ))}
    </PreviewScrollPane>
  );
}

function immediatePreviewContent(request: FilePreviewRequest): string | null {
  if (request.type === "content") {
    return request.content || "";
  }
  if (request.type === "diff") {
    return request.diff || "暂无 diff";
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
  if (request.type === "content") {
    return contentKindToPreviewKind(request.contentType);
  }
  if (request.type === "diff") {
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

function formatSource(content: string, kind: PreviewKind): string {
  if (!content) {
    return "文件为空";
  }
  if (kind !== "json") {
    return content;
  }
  try {
    return JSON.stringify(JSON.parse(content), null, 2);
  } catch {
    return content;
  }
}

function sourceLanguage(request: FilePreviewRequest, kind: PreviewKind): string {
  if (request.type === "content") {
    return kind === "mermaid" ? "mermaid" : kind;
  }
  if (request.type === "diff") {
    return "diff";
  }
  const ext = isPathPreviewRequest(request) ? request.path.split(".").pop()?.toLowerCase() ?? "" : "";
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

function previewTitle(request: FilePreviewRequest): string {
  if (request.type === "content") {
    return request.title;
  }
  return fileName(request.path);
}

function previewSourceLabel(request: FilePreviewRequest): string {
  if (request.type === "content") {
    return request.sourcePath ?? "消息内容";
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
