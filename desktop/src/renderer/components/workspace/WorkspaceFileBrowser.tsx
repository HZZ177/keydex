import { Folder, FolderOpen } from "lucide-react";
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

import { FilePreview } from "./FilePreview";
import { WorkspacePanel } from "./WorkspacePanel";
import styles from "./WorkspaceFileBrowser.module.css";

export interface WorkspaceFileBrowserProps {
  workspaceId?: string;
  sessionId?: string;
  label?: string;
  runtime: RuntimeBridge;
  previewPath?: string | null;
  previewRequestId?: number;
  onPreviewPathChange?: (path: string | null) => void;
}

const DEFAULT_TREE_WIDTH = 260;
const MIN_TREE_WIDTH = 180;
const MAX_TREE_WIDTH = 520;
const MIN_PREVIEW_WIDTH = 280;
const FILE_PREVIEW_CLOSE_MS = 180;

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
  onPreviewPathChange,
}: WorkspaceFileBrowserProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const resizeRef = useRef<ResizeState | null>(null);
  const previewUnmountTimerRef = useRef<number | null>(null);
  const previewOpenFrameRef = useRef<number | null>(null);
  const handledPreviewRequestIdRef = useRef(0);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [mountedPreviewPath, setMountedPreviewPath] = useState<string | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [treeCollapsed, setTreeCollapsed] = useState(false);
  const [treeWidth, setTreeWidth] = useState(DEFAULT_TREE_WIDTH);
  const previewRequest = useMemo(
    () => (mountedPreviewPath ? ({ type: "file", path: mountedPreviewPath } as const) : null),
    [mountedPreviewPath],
  );
  const previewMounted = Boolean(previewRequest);
  const currentPathLabel = formatBrowserPath(mountedPreviewPath);
  const toggleTreeCollapsed = useCallback(() => setTreeCollapsed((collapsed) => !collapsed), []);

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
    [clearPreviewOpenFrame, clearPreviewUnmountTimer, mountedPreviewPath, onPreviewPathChange],
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
    if (!previewPath || !previewRequestId || handledPreviewRequestIdRef.current === previewRequestId) {
      return;
    }
    handledPreviewRequestIdRef.current = previewRequestId;
    if (previewPath === mountedPreviewPath && previewOpen) {
      return;
    }
    openPreview(previewPath, false);
  }, [mountedPreviewPath, openPreview, previewOpen, previewPath, previewRequestId]);

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
    const maxWidth = Math.max(MIN_TREE_WIDTH, Math.min(MAX_TREE_WIDTH, drag.rootWidth - MIN_PREVIEW_WIDTH));
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
          data-testid="workspace-file-browser-tree"
          aria-hidden={treeCollapsed ? true : undefined}
          inert={treeCollapsed ? true : undefined}
        >
          <WorkspacePanel
            chrome="panel"
            label={label}
            runtime={runtime}
            workspaceId={workspaceId}
            sessionId={sessionId}
            selectedPath={selectedPath}
            onSelectFile={openPreview}
          />
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
            <div className={styles.previewPane} data-testid="workspace-file-browser-preview" aria-hidden={!previewOpen}>
              <FilePreview
                breadcrumbRootLabel={label}
                workspaceId={workspaceId}
                sessionId={sessionId}
                request={previewRequest}
                runtime={runtime}
                chrome="panel"
                hideBreadcrumbs
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

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function pointerIdValue(event: ReactPointerEvent<HTMLElement>): number {
  return Number.isFinite(event.pointerId) ? event.pointerId : 1;
}
