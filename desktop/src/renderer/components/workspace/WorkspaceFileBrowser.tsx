import { ChevronRight, Folder, FolderOpen, FolderTree, ListTree } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";

import type { RuntimeBridge } from "@/runtime";
import type {
  PreviewFileRevealTarget,
  PreviewAnnotationChatRequest,
  PreviewQuoteSelectionRequest,
} from "@/renderer/providers/PreviewProvider";

import {
  FilePreview,
  type FilePreviewRevealRequest,
  type MarkdownOutlineItem,
  type MarkdownOutlineRevealRequest,
} from "./FilePreview";
import { WorkspacePanel, type WorkspacePanelState } from "./WorkspacePanel";
import styles from "./WorkspaceFileBrowser.module.css";

export interface WorkspaceFileBrowserProps {
  workspaceId?: string;
  sessionId?: string;
  label?: string;
  runtime: RuntimeBridge;
  previewPath?: string | null;
  previewRequestId?: number;
  previewRevealTarget?: PreviewFileRevealTarget | null;
  previewPlacement?: "inline" | "external";
  initialNavigationMode?: "files" | "outline";
  previewOutline?: MarkdownOutlineItem[];
  previewOutlineReady?: boolean;
  bottomSafeArea?: string;
  initialState?: WorkspaceFileBrowserState | null;
  onQuoteSelection?: (request: PreviewQuoteSelectionRequest) => void;
  onStartChatFromAnnotation?: (request: PreviewAnnotationChatRequest | PreviewAnnotationChatRequest[]) => void;
  onPreviewPathChange?: (path: string | null) => void;
  onPreviewOutlineReveal?: (item: MarkdownOutlineItem) => void;
  onStateChange?: (state: WorkspaceFileBrowserState) => void;
}

const DEFAULT_TREE_WIDTH = 260;
const MIN_TREE_WIDTH = 180;
const MAX_TREE_WIDTH_RATIO = 0.7;
const MIN_PREVIEW_WIDTH = 280;
const FILE_PREVIEW_CLOSE_MS = 180;

type BrowserNavigationMode = "files" | "outline";

export interface WorkspaceFileBrowserState {
  selectedPath: string | null;
  mountedPreviewPath: string | null;
  previewOpen: boolean;
  treeCollapsed: boolean;
  treeWidth: number;
  navigationMode: BrowserNavigationMode;
  workspacePanelState: WorkspacePanelState | null;
}

interface ResizeState {
  pointerId: number;
  rootLeft: number;
  rootWidth: number;
  frame: number | null;
  pendingWidth: number;
}

export function WorkspaceFileBrowser({
  workspaceId,
  sessionId,
  label,
  runtime,
  previewPath = null,
  previewRequestId = 0,
  previewRevealTarget = null,
  previewPlacement = "inline",
  initialNavigationMode = "files",
  previewOutline = [],
  previewOutlineReady = false,
  bottomSafeArea,
  initialState = null,
  onQuoteSelection,
  onStartChatFromAnnotation,
  onPreviewPathChange,
  onPreviewOutlineReveal,
  onStateChange,
}: WorkspaceFileBrowserProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const resizeRef = useRef<ResizeState | null>(null);
  const previewUnmountTimerRef = useRef<number | null>(null);
  const previewOpenFrameRef = useRef<number | null>(null);
  const handledPreviewRequestIdRef = useRef(0);
  const [selectedPath, setSelectedPath] = useState<string | null>(initialState?.selectedPath ?? null);
  const [mountedPreviewPath, setMountedPreviewPath] = useState<string | null>(
    initialState?.mountedPreviewPath ?? null,
  );
  const [previewOpen, setPreviewOpen] = useState(initialState?.previewOpen ?? false);
  const [treeCollapsed, setTreeCollapsed] = useState(initialState?.treeCollapsed ?? false);
  const [treeWidth, setTreeWidth] = useState(initialState?.treeWidth ?? DEFAULT_TREE_WIDTH);
  const [navigationMode, setNavigationMode] = useState<BrowserNavigationMode>(
    initialState?.navigationMode ?? initialNavigationMode,
  );
  const [workspacePanelState, setWorkspacePanelState] = useState<WorkspacePanelState | null>(
    initialState?.workspacePanelState ?? null,
  );
  const [markdownOutline, setMarkdownOutline] = useState<MarkdownOutlineItem[]>([]);
  const [markdownOutlineReady, setMarkdownOutlineReady] = useState(false);
  const [outlineRevealRequest, setOutlineRevealRequest] = useState<MarkdownOutlineRevealRequest | null>(null);
  const previewRequest = useMemo(
    () => (mountedPreviewPath ? ({ type: "file", path: mountedPreviewPath } as const) : null),
    [mountedPreviewPath],
  );
  const fileRevealRequest = useMemo<FilePreviewRevealRequest | null>(
    () =>
      previewRevealTarget && previewRequestId
        ? {
            requestId: previewRequestId,
            selectedText: previewRevealTarget.selectedText ?? null,
            lineStart: previewRevealTarget.lineStart ?? null,
            lineEnd: previewRevealTarget.lineEnd ?? null,
            sourceStart: previewRevealTarget.sourceStart ?? null,
            sourceEnd: previewRevealTarget.sourceEnd ?? null,
          }
        : null,
    [
      previewRequestId,
      previewRevealTarget?.lineEnd,
      previewRevealTarget?.lineStart,
      previewRevealTarget?.selectedText,
      previewRevealTarget?.sourceEnd,
      previewRevealTarget?.sourceStart,
    ],
  );
  const previewMounted = Boolean(mountedPreviewPath);
  const outlinePath = previewPlacement === "external" ? previewPath : mountedPreviewPath;
  const activeOutline = previewPlacement === "external" ? previewOutline : markdownOutline;
  const activeOutlineReady = previewPlacement === "external" ? previewOutlineReady : markdownOutlineReady;
  const outlineAvailable = Boolean(outlinePath && isMarkdownPath(outlinePath));
  const outlineVisible = outlineAvailable && navigationMode === "outline";
  const currentPathLabel = formatBrowserPath(previewPlacement === "external" ? previewPath : mountedPreviewPath);
  const toggleTreeCollapsed = useCallback(() => setTreeCollapsed((collapsed) => !collapsed), []);

  useEffect(() => {
    onStateChange?.({
      selectedPath,
      mountedPreviewPath,
      previewOpen,
      treeCollapsed,
      treeWidth,
      navigationMode,
      workspacePanelState,
    });
  }, [
    mountedPreviewPath,
    navigationMode,
    onStateChange,
    previewOpen,
    selectedPath,
    treeCollapsed,
    treeWidth,
    workspacePanelState,
  ]);

  const clearPreviewUnmountTimer = useCallback(() => {
    if (previewUnmountTimerRef.current === null) {
      return;
    }
    window.clearTimeout(previewUnmountTimerRef.current);
    previewUnmountTimerRef.current = null;
  }, []);

  const clearPreviewOpenFrame = useCallback(() => {
    if (previewOpenFrameRef.current === null) {
      return;
    }
    window.cancelAnimationFrame(previewOpenFrameRef.current);
    previewOpenFrameRef.current = null;
  }, []);

  const setPreviewWidth = useCallback((width: number) => {
    const root = rootRef.current;
    if (!root) {
      return;
    }
    root.style.setProperty("--workspace-file-tree-width", `${Math.round(width)}px`);
  }, []);

  const schedulePreviewWidth = useCallback(
    (width: number) => {
      const drag = resizeRef.current;
      if (!drag) {
        return;
      }
      drag.pendingWidth = width;
      if (drag.frame !== null) {
        return;
      }
      drag.frame = window.requestAnimationFrame(() => {
        const activeDrag = resizeRef.current;
        if (!activeDrag) {
          return;
        }
        activeDrag.frame = null;
        setPreviewWidth(activeDrag.pendingWidth);
      });
    },
    [setPreviewWidth],
  );

  const stopResize = useCallback(
    (event?: ReactPointerEvent<HTMLDivElement>) => {
      const drag = resizeRef.current;
      if (!drag) {
        return;
      }
      if (drag.frame !== null) {
        window.cancelAnimationFrame(drag.frame);
      }
      resizeRef.current = null;
      setPreviewWidth(drag.pendingWidth);
      setTreeWidth(Math.round(drag.pendingWidth));
      if (rootRef.current) {
        delete rootRef.current.dataset.resizing;
      }
      if (event) {
        event.currentTarget.releasePointerCapture?.(event.pointerId);
      }
    },
    [setPreviewWidth],
  );

  const openPreview = useCallback(
    (path: string, notify = true) => {
      if (previewPlacement === "external") {
        if (notify) {
          onPreviewPathChange?.(path);
        }
        setSelectedPath(path);
        return;
      }
      clearPreviewUnmountTimer();
      clearPreviewOpenFrame();
      if (notify) {
        onPreviewPathChange?.(path);
      }
      setSelectedPath(path);
      setMountedPreviewPath(path);
      if (mountedPreviewPath) {
        setPreviewOpen(true);
        return;
      }
      setPreviewOpen(false);
      previewOpenFrameRef.current = window.requestAnimationFrame(() => {
        previewOpenFrameRef.current = null;
        setPreviewOpen(true);
      });
    },
    [
      clearPreviewOpenFrame,
      clearPreviewUnmountTimer,
      mountedPreviewPath,
      onPreviewPathChange,
      previewPlacement,
    ],
  );

  const closePreview = useCallback(() => {
    clearPreviewUnmountTimer();
    clearPreviewOpenFrame();
    onPreviewPathChange?.(null);
    setSelectedPath(null);
    setPreviewOpen(false);
    previewUnmountTimerRef.current = window.setTimeout(() => {
      previewUnmountTimerRef.current = null;
      setMountedPreviewPath(null);
    }, FILE_PREVIEW_CLOSE_MS);
  }, [clearPreviewOpenFrame, clearPreviewUnmountTimer, onPreviewPathChange]);

  useEffect(() => {
    setMarkdownOutline([]);
    setMarkdownOutlineReady(false);
    setOutlineRevealRequest(null);
    if (!outlinePath || !isMarkdownPath(outlinePath)) {
      setNavigationMode("files");
    }
  }, [outlinePath]);

  useEffect(() => {
    if (initialNavigationMode === "outline" && outlineAvailable) {
      setNavigationMode("outline");
    }
  }, [initialNavigationMode, outlineAvailable, outlinePath]);

  const handleMarkdownOutlineChange = useCallback((outline: MarkdownOutlineItem[]) => {
    setMarkdownOutline(outline);
    setMarkdownOutlineReady(true);
  }, []);

  const revealMarkdownOutlineItem = useCallback((item: MarkdownOutlineItem) => {
    if (previewPlacement === "external") {
      onPreviewOutlineReveal?.(item);
      return;
    }
    setOutlineRevealRequest((current) => ({
      requestId: (current?.requestId ?? 0) + 1,
      id: item.id,
      line: item.line,
    }));
  }, [onPreviewOutlineReveal, previewPlacement]);

  useEffect(() => {
    if (!previewPath) {
      if (previewPlacement === "external") {
        setSelectedPath(null);
      }
      return;
    }
    if (!previewRequestId || handledPreviewRequestIdRef.current === previewRequestId) {
      return;
    }
    handledPreviewRequestIdRef.current = previewRequestId;
    if (previewPlacement === "external") {
      setSelectedPath(previewPath);
      return;
    }
    if (previewPath === mountedPreviewPath && previewOpen) {
      return;
    }
    openPreview(previewPath, false);
  }, [mountedPreviewPath, openPreview, previewOpen, previewPath, previewRequestId, previewPlacement]);

  useEffect(
    () => () => {
      clearPreviewUnmountTimer();
      clearPreviewOpenFrame();
    },
    [clearPreviewOpenFrame, clearPreviewUnmountTimer],
  );

  const handleResizePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button > 0) {
      return;
    }
    const root = rootRef.current;
    if (!root) {
      return;
    }
    const rect = root.getBoundingClientRect();
    resizeRef.current = {
      pointerId: pointerIdValue(event),
      rootLeft: rect.left,
      rootWidth: rect.width,
      frame: null,
      pendingWidth: treeWidth,
    };
    root.dataset.resizing = "true";
    event.currentTarget.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  };

  const handleResizePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = resizeRef.current;
    if (!drag || drag.pointerId !== pointerIdValue(event)) {
      return;
    }
    const ratioMaxWidth = Math.floor(drag.rootWidth * MAX_TREE_WIDTH_RATIO);
    const previewMaxWidth = drag.rootWidth - MIN_PREVIEW_WIDTH;
    const maxWidth = Math.max(MIN_TREE_WIDTH, Math.min(ratioMaxWidth, previewMaxWidth));
    const nextWidth = clamp(event.clientX - drag.rootLeft, MIN_TREE_WIDTH, maxWidth);
    schedulePreviewWidth(nextWidth);
  };

  return (
    <section
      ref={rootRef}
      className={styles.browser}
      data-testid="workspace-file-browser"
      data-preview-mounted={previewMounted ? "true" : "false"}
      data-preview-layout-open={previewOpen ? "true" : "false"}
      data-preview-open={previewOpen ? "true" : "false"}
      data-tree-collapsed={treeCollapsed ? "true" : "false"}
      aria-label="工作区文件浏览器"
      style={{ "--workspace-file-tree-width": `${treeWidth}px` } as CSSProperties}
    >
      <header className={styles.pathHeader} data-testid="workspace-file-browser-pathbar">
        <PathBreadcrumbs path={mountedPreviewPath} title={currentPathLabel} />
        <button
          className={styles.treeToggleButton}
          type="button"
          aria-label={treeCollapsed ? "展开文件树" : "收起文件树"}
          title={treeCollapsed ? "展开文件树" : "收起文件树"}
          onClick={toggleTreeCollapsed}
        >
          {treeCollapsed ? (
            <Folder size={16} strokeWidth={1.8} />
          ) : (
            <FolderOpen size={16} strokeWidth={1.8} />
          )}
        </button>
      </header>
      <div className={styles.browserBody}>
        <div
          className={styles.treePane}
          data-collapsed={treeCollapsed ? "true" : "false"}
          data-outline-available={outlineAvailable ? "true" : "false"}
          data-navigation-mode={outlineVisible ? "outline" : "files"}
          data-testid="workspace-file-browser-tree"
          aria-hidden={treeCollapsed ? true : undefined}
          inert={treeCollapsed ? true : undefined}
        >
          {outlineAvailable ? (
            <BrowserNavigationTabs mode={navigationMode} onModeChange={setNavigationMode} />
          ) : null}
          <div
            className={styles.treeContent}
            data-active={outlineVisible ? "false" : "true"}
            aria-hidden={outlineVisible ? true : undefined}
            inert={outlineVisible ? true : undefined}
          >
            <WorkspacePanel
              chrome="panel"
              label={label}
              runtime={runtime}
              workspaceId={workspaceId}
              sessionId={sessionId}
              revealSelectedPathRequestId={previewRequestId}
              selectedPath={selectedPath}
              bottomSafeArea={bottomSafeArea}
              initialState={workspacePanelState}
              onSelectFile={openPreview}
              onStateChange={setWorkspacePanelState}
            />
          </div>
          {outlineAvailable ? (
            <div
              className={styles.outlinePane}
              data-active={outlineVisible ? "true" : "false"}
              aria-hidden={outlineVisible ? undefined : true}
              inert={outlineVisible ? undefined : true}
            >
              <MarkdownOutlinePanel
                outline={activeOutline}
                ready={activeOutlineReady}
                onReveal={revealMarkdownOutlineItem}
              />
            </div>
          ) : null}
        </div>
        {previewRequest ? (
          <>
            {!treeCollapsed ? (
              <div
                className={styles.resizeHandle}
                role="separator"
                aria-label="调整文件树宽度"
                aria-orientation="vertical"
                tabIndex={0}
                onPointerCancel={stopResize}
                onPointerDown={handleResizePointerDown}
                onPointerMove={handleResizePointerMove}
                onPointerUp={stopResize}
              />
            ) : null}
            <div
              className={styles.previewPane}
              data-workspace-file-preview-pane="true"
              data-testid="workspace-file-browser-preview"
              aria-hidden={!previewOpen}
            >
              <FilePreview
                breadcrumbRootLabel={label}
                workspaceId={workspaceId}
                sessionId={sessionId}
                request={previewRequest}
                runtime={runtime}
                chrome="panel"
                bottomSafeArea={bottomSafeArea}
                hideBreadcrumbs
                outlineRevealRequest={outlineRevealRequest}
                sourceRevealRequest={fileRevealRequest}
                onMarkdownOutlineChange={handleMarkdownOutlineChange}
                onQuoteSelection={onQuoteSelection}
                onStartChatFromAnnotation={onStartChatFromAnnotation}
                onClose={closePreview}
              />
            </div>
          </>
        ) : (
          <CollapsedEmptyState visible={treeCollapsed} />
        )}
      </div>
    </section>
  );
}

function BrowserNavigationTabs({
  mode,
  onModeChange,
}: {
  mode: BrowserNavigationMode;
  onModeChange: (mode: BrowserNavigationMode) => void;
}) {
  return (
    <div className={styles.navigationTabs} role="group" aria-label="文件导航模式" data-mode={mode}>
      <button
        type="button"
        data-testid="workspace-browser-files-tab"
        aria-pressed={mode === "files"}
        onClick={() => onModeChange("files")}
      >
        <FolderTree size={14} strokeWidth={1.8} />
        <span>文件</span>
      </button>
      <button
        type="button"
        data-testid="workspace-browser-outline-tab"
        aria-pressed={mode === "outline"}
        onClick={() => onModeChange("outline")}
      >
        <ListTree size={14} strokeWidth={1.8} />
        <span>大纲</span>
      </button>
    </div>
  );
}

function MarkdownOutlinePanel({
  outline,
  ready,
  onReveal,
}: {
  outline: MarkdownOutlineItem[];
  ready: boolean;
  onReveal: (item: MarkdownOutlineItem) => void;
}) {
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    setCollapsedIds(new Set());
  }, [outline]);
  const rows = useMemo(
    () => markdownOutlineRows(outline, collapsedIds),
    [collapsedIds, outline],
  );
  const toggleItem = useCallback((id: string) => {
    setCollapsedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  if (!ready) {
    return <div className={styles.outlineState}>正在读取文档大纲</div>;
  }
  if (!outline.length) {
    return <div className={styles.outlineState}>当前 Markdown 没有标题</div>;
  }
  return (
    <nav className={styles.outlinePanel} aria-label="Markdown 文档大纲">
      <div className={styles.outlineList}>
        {rows.map(({ collapsed, hasChildren, hidden, item }) => (
          <div
            key={item.id}
            className={styles.outlineItem}
            data-collapsed={collapsed ? "true" : "false"}
            data-has-children={hasChildren ? "true" : "false"}
            data-visible={hidden ? "false" : "true"}
            aria-hidden={hidden ? true : undefined}
            inert={hidden ? true : undefined}
            style={{ "--workspace-outline-indent": `${Math.max(0, item.level - 1) * 12}px` } as CSSProperties}
          >
            {hasChildren ? (
              <button
                className={styles.outlineToggle}
                type="button"
                aria-label={`${collapsed ? "展开" : "折叠"} ${item.title}`}
                aria-expanded={!collapsed}
                onClick={() => toggleItem(item.id)}
              >
                <ChevronRight size={13} strokeWidth={1.9} />
              </button>
            ) : (
              <span className={styles.outlineToggleSpacer} aria-hidden="true" />
            )}
            <button
              className={styles.outlineJump}
              type="button"
              aria-label={`跳转到 ${item.title}`}
              onClick={() => onReveal(item)}
            >
              <span className={styles.outlineTitle}>{item.title}</span>
            </button>
          </div>
        ))}
      </div>
    </nav>
  );
}

interface MarkdownOutlineRow {
  item: MarkdownOutlineItem;
  hasChildren: boolean;
  collapsed: boolean;
  hidden: boolean;
}

function markdownOutlineRows(
  outline: MarkdownOutlineItem[],
  collapsedIds: Set<string>,
): MarkdownOutlineRow[] {
  const collapsedAncestorLevels: number[] = [];
  return outline.map((item, index) => {
    while (collapsedAncestorLevels.length > 0 && item.level <= collapsedAncestorLevels[collapsedAncestorLevels.length - 1]) {
      collapsedAncestorLevels.pop();
    }
    const hidden = collapsedAncestorLevels.length > 0;
    const hasChildren = (outline[index + 1]?.level ?? 0) > item.level;
    const collapsed = hasChildren && collapsedIds.has(item.id);
    if (collapsed) {
      collapsedAncestorLevels.push(item.level);
    }
    return { item, hasChildren, collapsed, hidden };
  });
}

function PathBreadcrumbs({ path, title }: { path: string | null; title: string }) {
  const segments = pathSegments(path);

  return (
    <div className={styles.pathBreadcrumbs} title={title} aria-label={`当前路径 ${title}`}>
      <span className={styles.pathRoot}>/</span>
      {segments.map((segment, index) => {
        const last = index === segments.length - 1;
        return (
          <span className={styles.pathCrumb} data-last={last ? "true" : "false"} key={`${index}-${segment}`}>
            {index > 0 ? <span className={styles.pathSeparator}>/</span> : null}
            <span className={styles.pathName}>{segment}</span>
          </span>
        );
      })}
    </div>
  );
}

function CollapsedEmptyState({ visible }: { visible: boolean }) {
  return (
    <div
      className={styles.collapsedEmptyState}
      data-visible={visible ? "true" : "false"}
      data-testid="workspace-file-browser-empty"
      aria-hidden={!visible}
    >
      <FolderOpen className={styles.collapsedEmptyIcon} size={24} strokeWidth={1.7} />
      <strong>打开文件</strong>
      <span>从工作区目录树中选择文件</span>
    </div>
  );
}

function formatBrowserPath(path: string | null): string {
  if (!path) {
    return "/";
  }
  const normalized = path.replace(/\\/g, "/").replace(/^\/+/, "");
  return normalized ? `/${normalized}` : "/";
}

function pathSegments(path: string | null): string[] {
  if (!path) {
    return [];
  }
  return path.replace(/\\/g, "/").split("/").filter(Boolean);
}

function isMarkdownPath(path: string): boolean {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return ext === "md" || ext === "mdx" || ext === "markdown";
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function pointerIdValue(event: ReactPointerEvent<HTMLElement>): number {
  return Number.isFinite(event.pointerId) ? event.pointerId : 1;
}
