import {
  FileText,
  Folder,
  Maximize2,
  Minimize2,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState, type CSSProperties, type PropsWithChildren } from "react";
import { flushSync } from "react-dom";

import { useLayoutState } from "@/renderer/hooks/layout/LayoutStateProvider";
import { SIDEBAR_COLLAPSED_WIDTH } from "@/renderer/hooks/layout/layoutStore";
import type { RightSidebarPlacement } from "@/renderer/hooks/layout/layoutStore";
import { useSidebarCollapseMotion } from "@/renderer/hooks/layout/useSidebarCollapseMotion";
import { useOptionalPreview } from "@/renderer/providers/PreviewProvider";
import { FilePreview, WorkspaceFileBrowser } from "@/renderer/components/workspace";

import { RightSidebarResizeHandle } from "./RightSidebarResizeHandle";
import { RightSidebarInitialPage } from "./RightSidebarInitialPage";
import { SidebarResizeHandle } from "./SidebarResizeHandle";
import { Sider } from "./Sider";
import { Titlebar } from "./Titlebar";
import styles from "./Layout.module.css";
import type { SiderEntry } from "./Sider";

const FILES_PANEL_ID = "right-sidebar:files";
const GLOBAL_RIGHT_SIDEBAR_SCOPE = "global";

interface RightSidebarScopePanelState {
  filesOpen: boolean;
  activePanelId: string | null;
  filePreviewPath: string | null;
  filePreviewRequestId: number;
}

const EMPTY_RIGHT_SIDEBAR_SCOPE_STATE: RightSidebarScopePanelState = {
  filesOpen: false,
  activePanelId: null,
  filePreviewPath: null,
  filePreviewRequestId: 0,
};

type ViewTransitionDocument = Document & {
  startViewTransition?: (callback: () => void) => unknown;
};

export interface LayoutProps extends PropsWithChildren {
  title?: string;
  projects?: SiderEntry[];
  conversations?: SiderEntry[];
  activePath?: string;
  contentMode?: "reading" | "full";
  resetRightSidebarKey?: string;
  onNavigate?: (path: string) => void;
}

export function Layout({
  children,
  title = "Codex",
  projects,
  conversations,
  activePath,
  contentMode = "reading",
  resetRightSidebarKey,
  onNavigate,
}: LayoutProps) {
  const shellRef = useRef<HTMLDivElement>(null);
  const lastPreviewOpenStampRef = useRef<string | null>(null);
  const lastPreviewCollapseRequestRef = useRef(0);
  const lastFilePanelOpenRequestRef = useRef(0);
  const lastRightSidebarResetKeyRef = useRef<string | null>(null);
  const [rightSidebarMode, setRightSidebarMode] = useState<"split" | "maximized">("split");
  const [shellWidth, setShellWidth] = useState(() => (typeof window === "undefined" ? 0 : window.innerWidth));
  const { state, actions } = useLayoutState();
  const previewContext = useOptionalPreview();
  const collapsed = state.sidebarCollapsed;
  const { sidebarMotion, toggleSidebar } = useSidebarCollapseMotion(actions.toggleSidebar);
  const {
    sidebarMotion: rightSidebarMotion,
    startSidebarMotion: startRightSidebarMotion,
  } = useSidebarCollapseMotion(actions.toggleRightSidebar);
  const setLivePanelWidth = useCallback((property: string, width: number) => {
    shellRef.current?.style.setProperty(property, `${width}px`);
  }, []);
  const activeSidebarWidth = collapsed ? SIDEBAR_COLLAPSED_WIDTH : state.sidebarWidth;
  const getRightSidebarAvailableWidth = useCallback(() => {
    const rectWidth = shellRef.current?.getBoundingClientRect().width ?? 0;
    const liveShellWidth = rectWidth > 0 ? rectWidth : typeof window === "undefined" ? shellWidth : window.innerWidth;
    return Math.max(0, Math.round(liveShellWidth - activeSidebarWidth));
  }, [activeSidebarWidth, shellWidth]);
  const rightSidebarAvailableWidth = Math.max(0, shellWidth - activeSidebarWidth);
  const rightSidebarWidth = Math.round(rightSidebarAvailableWidth * state.rightSidebarRatio);
  const previewSidebarWidth = useCallback(
    (width: number) => setLivePanelWidth("--sidebar-width", width),
    [setLivePanelWidth],
  );
  const previewRightSidebarRatio = useCallback(
    (ratio: number) => {
      const shell = shellRef.current;
      if (!shell) {
        return;
      }
      shell.style.setProperty("--right-sidebar-ratio", String(ratio));
      shell.style.setProperty("--right-sidebar-width", `${Math.round(getRightSidebarAvailableWidth() * ratio)}px`);
    },
    [getRightSidebarAvailableWidth],
  );

  useEffect(() => {
    const shell = shellRef.current;
    if (!shell) {
      return;
    }
    const measureShellWidth = () => {
      const rectWidth = shell.getBoundingClientRect().width;
      const measuredWidth = rectWidth > 0 ? rectWidth : typeof window === "undefined" ? 0 : window.innerWidth;
      setShellWidth(Math.round(measuredWidth));
    };
    measureShellWidth();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measureShellWidth);
      return () => window.removeEventListener("resize", measureShellWidth);
    }
    const observer = new ResizeObserver(measureShellWidth);
    observer.observe(shell);
    window.addEventListener("resize", measureShellWidth);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measureShellWidth);
    };
  }, []);

  useEffect(() => {
    const activeEntry = previewContext?.open ? previewContext.activeEntry : null;
    if (!activeEntry) {
      return;
    }
    const openedStamp = `${activeEntry.id}:${activeEntry.openedAt}`;
    if (openedStamp === lastPreviewOpenStampRef.current) {
      return;
    }
    lastPreviewOpenStampRef.current = openedStamp;
    if (!state.rightSidebarOpen) {
      setRightSidebarMode("split");
      startRightSidebarMotion();
    }
    actions.setRightSidebarOpen(true);
  }, [
    actions,
    previewContext?.activeEntry,
    previewContext?.open,
    startRightSidebarMotion,
    state.rightSidebarOpen,
  ]);

  useEffect(() => {
    const collapseRequestId = previewContext?.collapseRequestId ?? 0;
    if (collapseRequestId === 0 || collapseRequestId === lastPreviewCollapseRequestRef.current) {
      return;
    }
    lastPreviewCollapseRequestRef.current = collapseRequestId;
    setRightSidebarMode("split");
    if (state.rightSidebarOpen) {
      startRightSidebarMotion();
    }
    actions.setRightSidebarOpen(false);
  }, [actions, previewContext?.collapseRequestId, startRightSidebarMotion, state.rightSidebarOpen]);

  useEffect(() => {
    const filePanelRequest = previewContext?.filePanelRequest ?? null;
    if (
      !filePanelRequest?.requestId ||
      filePanelRequest.requestId === lastFilePanelOpenRequestRef.current ||
      filePanelRequest.scopeKey !== previewContext?.activeScopeKey
    ) {
      return;
    }
    lastFilePanelOpenRequestRef.current = filePanelRequest.requestId;
    setRightSidebarMode("split");
    if (!state.rightSidebarOpen) {
      startRightSidebarMotion();
    }
    actions.setRightSidebarOpen(true);
  }, [
    actions,
    previewContext?.activeScopeKey,
    previewContext?.filePanelRequest?.requestId,
    previewContext?.filePanelRequest?.scopeKey,
    startRightSidebarMotion,
    state.rightSidebarOpen,
  ]);

  const closeRightSidebar = useCallback(() => {
    setRightSidebarMode("split");
    if (state.rightSidebarOpen) {
      startRightSidebarMotion();
    }
    actions.setRightSidebarOpen(false);
  }, [actions, startRightSidebarMotion, state.rightSidebarOpen]);

  const openRightSidebar = useCallback(() => {
    setRightSidebarMode("split");
    if (!state.rightSidebarOpen) {
      startRightSidebarMotion();
    }
    actions.setRightSidebarOpen(true);
  }, [actions, startRightSidebarMotion, state.rightSidebarOpen]);

  const maximizeRightSidebar = useCallback(() => {
    if (!state.rightSidebarOpen) {
      actions.setRightSidebarOpen(true);
    }
    startRightSidebarMotion();
    setRightSidebarMode("maximized");
  }, [actions, startRightSidebarMotion, state.rightSidebarOpen]);

  const restoreRightSidebar = useCallback(() => {
    startRightSidebarMotion();
    setRightSidebarMode("split");
  }, [startRightSidebarMotion]);

  const swapRightSidebarPlacement = useCallback(() => {
    setRightSidebarMode("split");
    startRightSidebarMotion();

    const applyPlacementSwap = () => actions.toggleRightSidebarPlacement();
    const viewTransitionDocument = typeof document === "undefined" ? null : (document as ViewTransitionDocument);
    const prefersReducedMotion =
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    if (!prefersReducedMotion && typeof viewTransitionDocument?.startViewTransition === "function") {
      viewTransitionDocument.startViewTransition(() => {
        flushSync(applyPlacementSwap);
      });
      return;
    }

    applyPlacementSwap();
  }, [actions, startRightSidebarMotion]);

  const navigateFromShell = useCallback(
    (path: string) => {
      if (path === "/guid" || path.startsWith("/guid?")) {
        closeRightSidebar();
      }
      onNavigate?.(path);
    },
    [closeRightSidebar, onNavigate],
  );

  useEffect(() => {
    if (!resetRightSidebarKey || lastRightSidebarResetKeyRef.current === resetRightSidebarKey) {
      return;
    }
    lastRightSidebarResetKeyRef.current = resetRightSidebarKey;
    closeRightSidebar();
  }, [closeRightSidebar, resetRightSidebarKey]);

  const rightSidebarMaximized = state.rightSidebarOpen && rightSidebarMode === "maximized";
  const rightSidebarOnLeft = state.rightSidebarPlacement === "left";
  const openRightSidebarLabel = rightSidebarOnLeft ? "展开左侧栏" : "展开右侧栏";
  const OpenRightSidebarIcon = rightSidebarOnLeft ? PanelLeftOpen : PanelRightOpen;

  return (
    <div
      ref={shellRef}
      className={styles.shell}
      data-testid="app-shell"
      data-sidebar={collapsed ? "collapsed" : "expanded"}
      data-sidebar-motion={sidebarMotion ? "true" : "false"}
      data-right-sidebar={state.rightSidebarOpen ? "open" : "closed"}
      data-right-sidebar-mode={rightSidebarMaximized ? "maximized" : "split"}
      data-right-sidebar-motion={rightSidebarMotion ? "true" : "false"}
      data-right-sidebar-placement={state.rightSidebarPlacement}
      data-workspace={state.workspaceOpen ? "open" : "closed"}
      data-preview={state.previewOpen ? "open" : "closed"}
      style={
        {
          "--sidebar-width": `${state.sidebarWidth}px`,
          "--right-sidebar-ratio": String(state.rightSidebarRatio),
          "--right-sidebar-width": `${rightSidebarWidth}px`,
          "--workspace-panel-width": `${state.workspaceWidth}px`,
          "--preview-panel-width": `${state.previewWidth}px`,
        } as CSSProperties
      }
    >
      <Titlebar
        title={title}
        sidebarCollapsed={collapsed}
        onToggleSidebar={toggleSidebar}
      />

      <div className={styles.body}>
        <Sider
          activePath={activePath}
          collapsed={collapsed}
          projects={projects}
          conversations={conversations}
          onNavigate={navigateFromShell}
        />
        <SidebarResizeHandle
          disabled={collapsed}
          width={state.sidebarWidth}
          onResizePreview={previewSidebarWidth}
          onResize={actions.setSidebarWidth}
        />

        <section className={styles.content} data-content={contentMode} aria-label="主内容区">
          <div className={styles.readingColumn} data-content={contentMode}>
            {children}
          </div>
        </section>
        {!state.rightSidebarOpen ? (
          <button
            className={styles.contentRightSidebarToggle}
            data-icon={rightSidebarOnLeft ? "panel-left-open" : "panel-right-open"}
            type="button"
            aria-label={openRightSidebarLabel}
            title={openRightSidebarLabel}
            onClick={openRightSidebar}
          >
            <OpenRightSidebarIcon size={17} strokeWidth={2.1} />
          </button>
        ) : null}

        <RightSidebarResizeHandle
          disabled={!state.rightSidebarOpen || rightSidebarMaximized}
          ratio={state.rightSidebarRatio}
          placement={state.rightSidebarPlacement}
          getAvailableWidth={getRightSidebarAvailableWidth}
          onResizePreview={previewRightSidebarRatio}
          onResize={actions.setRightSidebarRatio}
          onSwapPlacement={swapRightSidebarPlacement}
        />
        <RightSidebarPanel
          open={state.rightSidebarOpen}
          maximized={rightSidebarMaximized}
          placement={state.rightSidebarPlacement}
          onClose={closeRightSidebar}
          onMaximize={maximizeRightSidebar}
          onRestore={restoreRightSidebar}
        />
      </div>
    </div>
  );
}

function RightSidebarPanel({
  open,
  maximized,
  placement,
  onClose,
  onMaximize,
  onRestore,
}: {
  open: boolean;
  maximized: boolean;
  placement: RightSidebarPlacement;
  onClose: () => void;
  onMaximize: () => void;
  onRestore: () => void;
}) {
  const previewContext = useOptionalPreview();
  const activeScopeKey = previewContext?.activeScopeKey ?? GLOBAL_RIGHT_SIDEBAR_SCOPE;
  const request = previewContext?.open ? previewContext.request : null;
  const renderContext = previewContext?.activeRenderContext;
  const rawFilePanelRequest = previewContext?.filePanelRequest ?? null;
  const filePanelRequest =
    rawFilePanelRequest && rawFilePanelRequest.scopeKey === previewContext?.activeScopeKey
      ? rawFilePanelRequest
      : null;
  const filePanelRenderContext = filePanelRequest?.renderContext ?? renderContext;
  const entries = previewContext?.entries ?? [];
  const activeEntryId = previewContext?.activeEntryId ?? null;
  const [panelStateByScope, setPanelStateByScope] = useState<Record<string, RightSidebarScopePanelState>>({});
  const scopedPanelState = panelStateByScope[activeScopeKey] ?? EMPTY_RIGHT_SIDEBAR_SCOPE_STATE;
  const filesOpen = scopedPanelState.filesOpen;
  const activePanelId = scopedPanelState.activePanelId;
  const filePreviewPath = scopedPanelState.filePreviewPath;
  const filePreviewRequestId = scopedPanelState.filePreviewRequestId;
  const canOpenFiles = Boolean(
    filePanelRenderContext?.workspaceAvailable &&
      filePanelRenderContext?.runtime &&
      (filePanelRenderContext?.sessionId || filePanelRenderContext?.workspaceId),
  );
  const resolvedActivePanelId = activePanelId ?? activeEntryId ?? (filesOpen ? FILES_PANEL_ID : null);
  const activePreviewEntry =
    resolvedActivePanelId && resolvedActivePanelId !== FILES_PANEL_ID
      ? entries.find((entry) => entry.id === resolvedActivePanelId) ?? null
      : null;
  const activeRequest = activePreviewEntry?.request ?? (resolvedActivePanelId === activeEntryId ? request : null);
  const activeRenderContext = activePreviewEntry?.renderContext ?? renderContext;
  const showFilesPanel = filesOpen && resolvedActivePanelId === FILES_PANEL_ID;
  const panelActivePreviewEntryId =
    open && resolvedActivePanelId && resolvedActivePanelId !== FILES_PANEL_ID
      ? activePreviewEntry?.id ?? (resolvedActivePanelId === activeEntryId ? activeEntryId : null)
      : null;

  const updateActiveScopePanelState = useCallback(
    (updater: (state: RightSidebarScopePanelState) => RightSidebarScopePanelState) => {
      setPanelStateByScope((current) => {
        const previous = current[activeScopeKey] ?? EMPTY_RIGHT_SIDEBAR_SCOPE_STATE;
        const next = updater(previous);
        if (sameRightSidebarScopePanelState(previous, next)) {
          return current;
        }
        return { ...current, [activeScopeKey]: next };
      });
    },
    [activeScopeKey],
  );

  useEffect(() => {
    previewContext?.setPreviewPanelOpen(open, panelActivePreviewEntryId);
  }, [open, panelActivePreviewEntryId, previewContext]);

  useEffect(() => {
    if (activeEntryId) {
      updateActiveScopePanelState((current) => ({ ...current, activePanelId: activeEntryId }));
    }
  }, [activeEntryId, previewContext?.activeEntry?.openedAt, updateActiveScopePanelState]);

  useEffect(() => {
    if (canOpenFiles || !filesOpen) {
      return;
    }
    updateActiveScopePanelState((current) => ({ ...current, filesOpen: false, activePanelId: activeEntryId ?? null }));
  }, [activeEntryId, canOpenFiles, filesOpen, updateActiveScopePanelState]);

  useEffect(() => {
    const filePanelRequestId = filePanelRequest?.requestId ?? 0;
    if (!filePanelRequestId || !canOpenFiles) {
      return;
    }
    updateActiveScopePanelState((current) => ({
      ...current,
      filesOpen: true,
      activePanelId: FILES_PANEL_ID,
      filePreviewPath: filePanelRequest?.path ?? null,
      filePreviewRequestId: Math.max(current.filePreviewRequestId + 1, filePanelRequestId),
    }));
  }, [canOpenFiles, filePanelRequest?.path, filePanelRequest?.requestId, updateActiveScopePanelState]);

  const openFilesPanel = useCallback(() => {
    if (!canOpenFiles) {
      return;
    }
    updateActiveScopePanelState((current) => ({ ...current, filesOpen: true, activePanelId: FILES_PANEL_ID }));
  }, [canOpenFiles, updateActiveScopePanelState]);

  const closeFilesPanel = useCallback(() => {
    const shouldCloseSidebar = entries.length === 0;
    updateActiveScopePanelState((current) => ({
      ...current,
      filesOpen: false,
      activePanelId:
        current.activePanelId === FILES_PANEL_ID ? activeEntryId ?? entries[0]?.id ?? null : current.activePanelId,
    }));
    if (shouldCloseSidebar) {
      onClose();
    }
  }, [activeEntryId, entries, onClose, updateActiveScopePanelState]);

  const closePreviewEntry = useCallback(
    (entryId: string) => {
      const closedIndex = entries.findIndex((entry) => entry.id === entryId);
      const remainingEntries = entries.filter((entry) => entry.id !== entryId);
      const shouldCloseSidebar = remainingEntries.length === 0 && !filesOpen;
      previewContext?.closePreviewEntry(entryId);
      updateActiveScopePanelState((current) => {
        if (current.activePanelId !== entryId) {
          return current;
        }
        const nextEntry =
          remainingEntries[Math.max(0, Math.min(closedIndex - 1, remainingEntries.length - 1))] ?? null;
        return { ...current, activePanelId: nextEntry?.id ?? (filesOpen ? FILES_PANEL_ID : null) };
      });
      if (shouldCloseSidebar) {
        onClose();
      }
    },
    [entries, filesOpen, onClose, previewContext, updateActiveScopePanelState],
  );

  const openPanelEntry = useCallback(
    (entryId: string) => {
      updateActiveScopePanelState((current) => ({ ...current, activePanelId: entryId }));
      previewContext?.switchPreview(entryId);
    },
    [previewContext, updateActiveScopePanelState],
  );

  const activateFilesPanel = useCallback(() => {
    updateActiveScopePanelState((current) => ({ ...current, activePanelId: FILES_PANEL_ID }));
  }, [updateActiveScopePanelState]);

  const updateFilePanelPreviewPath = useCallback(
    (path: string | null) => {
      updateActiveScopePanelState((current) => ({
        ...current,
        filePreviewPath: path,
        filePreviewRequestId: current.filePreviewRequestId + 1,
      }));
    },
    [updateActiveScopePanelState],
  );

  const controls = (
    <RightSidebarControls
      maximized={maximized}
      placement={placement}
      onClose={onClose}
      onMaximize={onMaximize}
      onRestore={onRestore}
    />
  );
  const panelLabel = placement === "left" ? "左侧栏" : "右侧栏";

  return (
    <aside className={styles.rightSidebar} aria-label={panelLabel} aria-hidden={!open}>
      {open ? (
        <>
          <div className={styles.rightSidebarTopbar}>
            <div className={styles.rightSidebarTabs} role="tablist" aria-label="侧边栏窗口">
              {filesOpen ? (
                <div className={styles.rightSidebarTab} data-active={showFilesPanel ? "true" : "false"}>
                  <button
                    className={styles.rightSidebarTabMain}
                    type="button"
                    role="tab"
                    aria-selected={showFilesPanel}
                    title="文件"
                    onClick={activateFilesPanel}
                  >
                    <Folder size={12} />
                    <span>文件</span>
                  </button>
                  <button
                    className={styles.rightSidebarTabClose}
                    type="button"
                    aria-label="关闭侧边栏窗口 文件"
                    title="关闭侧边栏窗口 文件"
                    onClick={(event) => {
                      event.stopPropagation();
                      closeFilesPanel();
                    }}
                  >
                    <X size={11} />
                  </button>
                </div>
              ) : null}
              {entries.map((entry) => {
                const active = resolvedActivePanelId === entry.id;
                return (
                  <div className={styles.rightSidebarTab} data-active={active ? "true" : "false"} key={entry.id}>
                    <button
                      className={styles.rightSidebarTabMain}
                      type="button"
                      role="tab"
                      aria-selected={active}
                      title={entry.sourceLabel}
                      onClick={() => openPanelEntry(entry.id)}
                    >
                      <FileText size={12} />
                      <span>{entry.title}</span>
                    </button>
                    <button
                      className={styles.rightSidebarTabClose}
                      type="button"
                      aria-label={`关闭侧边栏窗口 ${entry.title}`}
                      title={`关闭侧边栏窗口 ${entry.title}`}
                      onClick={(event) => {
                        event.stopPropagation();
                        closePreviewEntry(entry.id);
                      }}
                    >
                      <X size={11} />
                    </button>
                  </div>
                );
              })}
            </div>
            <div className={styles.rightSidebarPanelControls}>
              {controls}
            </div>
          </div>
          {showFilesPanel && filePanelRenderContext?.runtime && (filePanelRenderContext.sessionId || filePanelRenderContext.workspaceId) ? (
            <div className={styles.rightSidebarBody} data-content="files">
              <WorkspaceFileBrowser
                label={filePanelRenderContext.workspaceLabel}
                runtime={filePanelRenderContext.runtime}
                workspaceId={filePanelRenderContext.workspaceId}
                sessionId={filePanelRenderContext.sessionId}
                previewPath={filePreviewPath}
                previewRequestId={filePreviewRequestId}
                onPreviewPathChange={updateFilePanelPreviewPath}
              />
            </div>
          ) : activeRequest ? (
            <div className={styles.rightSidebarBody} data-content="preview">
              <FilePreview
                breadcrumbRootLabel={
                  activeRequest.type === "content" && !activeRequest.sourcePath
                    ? undefined
                    : activeRenderContext?.workspaceLabel
                }
                workspaceId={activeRenderContext?.workspaceId}
                sessionId={activeRenderContext?.sessionId}
                request={activeRequest}
                runtime={activeRenderContext?.runtime}
                onQuoteSelection={activeRenderContext?.onQuoteSelection}
                chrome="panel"
              />
            </div>
          ) : (
            <div className={styles.rightSidebarBody} data-content="empty">
              <RightSidebarInitialPage canOpenFiles={canOpenFiles} onOpenFiles={openFilesPanel} />
            </div>
          )}
        </>
      ) : null}
    </aside>
  );
}

function sameRightSidebarScopePanelState(
  left: RightSidebarScopePanelState,
  right: RightSidebarScopePanelState,
): boolean {
  return (
    left.filesOpen === right.filesOpen &&
    left.activePanelId === right.activePanelId &&
    left.filePreviewPath === right.filePreviewPath &&
    left.filePreviewRequestId === right.filePreviewRequestId
  );
}

function RightSidebarControls({
  maximized,
  placement,
  onClose,
  onMaximize,
  onRestore,
}: {
  maximized: boolean;
  placement: RightSidebarPlacement;
  onClose: () => void;
  onMaximize: () => void;
  onRestore: () => void;
}) {
  const onLeft = placement === "left";
  const placementLabel = onLeft ? "左侧栏" : "右侧栏";
  const CloseIcon = onLeft ? PanelLeftClose : PanelRightClose;

  return (
    <>
      <button
        className={styles.rightSidebarIconButton}
        data-icon={maximized ? "minimize-2" : "maximize-2"}
        type="button"
        aria-label={maximized ? `缩小${placementLabel}` : `展开${placementLabel}到对话区域`}
        title={maximized ? `缩小${placementLabel}` : `展开${placementLabel}到对话区域`}
        onClick={maximized ? onRestore : onMaximize}
      >
        {maximized ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
      </button>
      <button
        className={styles.rightSidebarIconButton}
        data-icon={onLeft ? "panel-left-close" : "panel-right-close"}
        type="button"
        aria-label={`折叠${placementLabel}`}
        title={`折叠${placementLabel}`}
        onClick={onClose}
      >
        <CloseIcon size={17} strokeWidth={2.1} />
      </button>
    </>
  );
}
