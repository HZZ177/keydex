import {
  FileText,
  Folder,
  Maximize2,
  Minimize2,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Plus,
  X,
} from "lucide-react";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PropsWithChildren,
} from "react";
import { flushSync } from "react-dom";

import { useLayoutState } from "@/renderer/hooks/layout/LayoutStateProvider";
import { SIDEBAR_COLLAPSED_WIDTH } from "@/renderer/hooks/layout/layoutStore";
import type { RightSidebarPlacement } from "@/renderer/hooks/layout/layoutStore";
import { useSidebarCollapseMotion } from "@/renderer/hooks/layout/useSidebarCollapseMotion";
import { useOptionalPreview, type PreviewQuoteSelectionRequest } from "@/renderer/providers/PreviewProvider";
import { useOptionalRuntimeConnection } from "@/renderer/providers/RuntimeConnectionProvider";
import { ConnectionStatus } from "@/renderer/components/runtime";

import { RightSidebarResizeHandle } from "./RightSidebarResizeHandle";
import { RightSidebarInitialPage } from "./RightSidebarInitialPage";
import { SidebarResizeHandle } from "./SidebarResizeHandle";
import { Sider } from "./Sider";
import { Titlebar } from "./Titlebar";
import styles from "./Layout.module.css";
import type { SiderEntry } from "./Sider";

const LazyWorkspaceFileBrowser = lazy(() =>
  import("@/renderer/components/workspace/WorkspaceFileBrowser").then((module) => ({
    default: module.WorkspaceFileBrowser,
  })),
);
const LazyFilePreview = lazy(() =>
  import("@/renderer/components/workspace/FilePreview").then((module) => ({ default: module.FilePreview })),
);

const LEGACY_FILES_PANEL_ID = "right-sidebar:files";
const FILES_PANEL_ID_PREFIX = "right-sidebar:files:";
const INITIAL_PANEL_ID_PREFIX = "right-sidebar:initial:";
const GLOBAL_RIGHT_SIDEBAR_SCOPE = "global";

interface RightSidebarFilePanelState {
  id: string;
  filePreviewPath: string | null;
  filePreviewRequestId: number;
}

interface RightSidebarScopePanelState {
  activePanelId: string | null;
  panelOrder: string[];
  filePanelIds: string[];
  filePanels: Record<string, RightSidebarFilePanelState>;
  initialPanelIds: string[];
  nextPanelSeq: number;
}

const EMPTY_RIGHT_SIDEBAR_SCOPE_STATE: RightSidebarScopePanelState = {
  activePanelId: null,
  panelOrder: [],
  filePanelIds: [],
  filePanels: {},
  initialPanelIds: [],
  nextPanelSeq: 0,
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
  title = "Keydex",
  projects,
  conversations,
  activePath,
  contentMode = "reading",
  resetRightSidebarKey,
  onNavigate,
}: LayoutProps) {
  const shellRef = useRef<HTMLDivElement>(null);
  const previewContext = useOptionalPreview();
  const lastPreviewOpenStampRef = useRef<string | null>(
    previewContext?.open ? previewOpenStamp(previewContext.activeEntry) : null,
  );
  const lastPreviewCollapseRequestRef = useRef(previewContext?.collapseRequestId ?? 0);
  const lastFilePanelOpenRequestRef = useRef(previewContext?.filePanelRequest?.requestId ?? 0);
  const lastPreviewScopeKeyRef = useRef<string | null>(previewContext?.activeScopeKey ?? null);
  const lastRightSidebarResetKeyRef = useRef<string | null>(null);
  const [rightSidebarMode, setRightSidebarMode] = useState<"split" | "maximized">("split");
  const [shellWidth, setShellWidth] = useState(() => (typeof window === "undefined" ? 0 : window.innerWidth));
  const { state, actions } = useLayoutState();
  const runtimeConnection = useOptionalRuntimeConnection();
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
  const setRightSidebarResizing = useCallback((resizing: boolean) => {
    const shell = shellRef.current;
    if (!shell) {
      return;
    }
    if (resizing) {
      shell.dataset.rightSidebarResizing = "true";
      return;
    }
    delete shell.dataset.rightSidebarResizing;
  }, []);

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
    const activeScopeKey = previewContext?.activeScopeKey ?? null;
    if (lastPreviewScopeKeyRef.current === activeScopeKey) {
      return;
    }
    lastPreviewScopeKeyRef.current = activeScopeKey;

    if (previewContext?.open) {
      lastPreviewOpenStampRef.current = previewOpenStamp(previewContext.activeEntry);
    }

    const filePanelRequest = previewContext?.filePanelRequest ?? null;
    if (filePanelRequest?.requestId && filePanelRequest.scopeKey === activeScopeKey) {
      lastFilePanelOpenRequestRef.current = filePanelRequest.requestId;
    }
  }, [
    previewContext?.activeEntry,
    previewContext?.activeScopeKey,
    previewContext?.filePanelRequest?.requestId,
    previewContext?.filePanelRequest?.scopeKey,
    previewContext?.open,
  ]);

  useEffect(() => {
    const activeEntry = previewContext?.open ? previewContext.activeEntry : null;
    if (!activeEntry) {
      return;
    }
    const openedStamp = previewOpenStamp(activeEntry);
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
  const showRuntimeStatus = Boolean(runtimeConnection && runtimeConnection.status === "error");

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
      <Titlebar title={title} />

      {showRuntimeStatus && runtimeConnection ? (
        <ConnectionStatus
          state={runtimeConnection.runtimeState}
          onClearAll={runtimeConnection.clearAllErrors}
          onClearError={runtimeConnection.clearError}
          onRetry={runtimeConnection.retry}
        />
      ) : null}

      <div className={styles.body}>
        <Sider
          activePath={activePath}
          collapsed={collapsed}
          projects={projects}
          conversations={conversations}
          onToggleSidebar={toggleSidebar}
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
          onResizeDragChange={setRightSidebarResizing}
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
  const syncedPreviewOpenStampsRef = useRef<Set<string>>(new Set());
  const previousFilePanelScopeRef = useRef(activeScopeKey);
  const previousScopeHadFilePanelRef = useRef(false);
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
  const scopedPanelState = normalizeRightSidebarScopePanelState(panelStateByScope[activeScopeKey]);
  const activePanelId = scopedPanelState.activePanelId;
  const filePanelIds = scopedPanelState.filePanelIds;
  const filePanels = scopedPanelState.filePanels;
  const initialPanelIds = scopedPanelState.initialPanelIds;
  const entryIds = entries.map((entry) => entry.id);
  const orderedPanelIds = orderedRightSidebarPanelIds(scopedPanelState, entryIds);
  const canOpenFiles = Boolean(
    filePanelRenderContext?.workspaceAvailable &&
      filePanelRenderContext?.runtime &&
      (filePanelRenderContext?.sessionId || filePanelRenderContext?.workspaceId),
  );
  const resolvedActivePanelId = activePanelId ?? activeEntryId ?? orderedPanelIds[0] ?? null;
  const activeFilePanel = resolvedActivePanelId ? (filePanels[resolvedActivePanelId] ?? null) : null;
  const activePreviewEntry =
    resolvedActivePanelId && !activeFilePanel && !initialPanelIds.includes(resolvedActivePanelId)
      ? entries.find((entry) => entry.id === resolvedActivePanelId) ?? null
      : null;
  const activeRequest = activePreviewEntry?.request ?? (resolvedActivePanelId === activeEntryId ? request : null);
  const activeRenderContext = activePreviewEntry?.renderContext ?? renderContext;
  const filePanelQuoteSelection = useCallback(
    (request: PreviewQuoteSelectionRequest) => {
      filePanelRenderContext?.onQuoteSelection?.(request);
      if (maximized) {
        onRestore();
      }
    },
    [filePanelRenderContext?.onQuoteSelection, maximized, onRestore],
  );
  const activePreviewQuoteSelection = useCallback(
    (request: PreviewQuoteSelectionRequest) => {
      activeRenderContext?.onQuoteSelection?.(request);
      if (maximized) {
        onRestore();
      }
    },
    [activeRenderContext?.onQuoteSelection, maximized, onRestore],
  );
  const showFilesPanel = Boolean(activeFilePanel);
  const panelActivePreviewEntryId =
    open && resolvedActivePanelId && !activeFilePanel && !initialPanelIds.includes(resolvedActivePanelId)
      ? activePreviewEntry?.id ?? (resolvedActivePanelId === activeEntryId ? activeEntryId : null)
      : null;

  const updateActiveScopePanelState = useCallback(
    (updater: (state: RightSidebarScopePanelState) => RightSidebarScopePanelState) => {
      setPanelStateByScope((current) => {
        const previous = normalizeRightSidebarScopePanelState(current[activeScopeKey]);
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
    const scopeChanged = previousFilePanelScopeRef.current !== activeScopeKey;
    const previousScopeHadFilePanel = previousScopeHadFilePanelRef.current;
    previousFilePanelScopeRef.current = activeScopeKey;
    previousScopeHadFilePanelRef.current = filePanelIds.length > 0;
    if (!scopeChanged || !previousScopeHadFilePanel || !open || !canOpenFiles || filePanelIds.length > 0) {
      return;
    }
    updateActiveScopePanelState((current) => activateOrCreateFilePanel(current));
  }, [activeScopeKey, canOpenFiles, filePanelIds.length, open, updateActiveScopePanelState]);

  useEffect(() => {
    const activeEntry = previewContext?.activeEntry;
    if (!activeEntryId || !activeEntry) {
      return;
    }
    const stamp = `${activeEntryId}:${activeEntry.openedAt}`;
    if (syncedPreviewOpenStampsRef.current.has(stamp)) {
      return;
    }
    syncedPreviewOpenStampsRef.current.add(stamp);
    updateActiveScopePanelState((current) => ({
      ...current,
      activePanelId: activeEntryId,
      panelOrder: appendPanelOrder(current.panelOrder, activeEntryId),
    }));
  }, [activeEntryId, previewContext?.activeEntry?.openedAt, updateActiveScopePanelState]);

  useEffect(() => {
    if (canOpenFiles || filePanelIds.length === 0) {
      return;
    }
    updateActiveScopePanelState((current) => {
      const activeFilePanelId = activeFilePanelIdForState(current);
      const nextPanelOrder = current.panelOrder.filter((id) => !current.filePanels[id]);
      const activePanelId =
        activeFilePanelId && current.activePanelId === activeFilePanelId
          ? activeEntryId ?? nextPanelOrder[0] ?? null
          : current.activePanelId;
      return {
        ...current,
        activePanelId,
        panelOrder: nextPanelOrder,
        filePanelIds: [],
        filePanels: {},
      };
    });
  }, [activeEntryId, canOpenFiles, filePanelIds.length, updateActiveScopePanelState]);

  useEffect(() => {
    const filePanelRequestId = filePanelRequest?.requestId ?? 0;
    if (!filePanelRequestId || !canOpenFiles) {
      return;
    }
    updateActiveScopePanelState((current) =>
      activateOrCreateFilePanel(current, {
        path: filePanelRequest?.path ?? null,
        requestId: filePanelRequestId,
        preferExisting: true,
      }),
    );
  }, [canOpenFiles, filePanelRequest?.path, filePanelRequest?.requestId, updateActiveScopePanelState]);

  const openFilesPanel = useCallback(() => {
    if (!canOpenFiles) {
      return;
    }
    updateActiveScopePanelState((current) => activateOrCreateFilePanel(current));
  }, [canOpenFiles, updateActiveScopePanelState]);

  const closeFilesPanel = useCallback(
    (panelId: string) => {
      const remainingFilePanelIds = filePanelIds.filter((id) => id !== panelId);
      const shouldCloseSidebar =
        entries.length === 0 &&
        initialPanelIds.length === 0 &&
        remainingFilePanelIds.length === 0 &&
        resolvedActivePanelId === panelId;
      updateActiveScopePanelState((current) => {
        const nextFilePanelIds = current.filePanelIds.filter((id) => id !== panelId);
        const nextFilePanels = { ...current.filePanels };
        delete nextFilePanels[panelId];
        if (current.activePanelId !== panelId) {
          return {
            ...current,
            panelOrder: current.panelOrder.filter((id) => id !== panelId),
            filePanelIds: nextFilePanelIds,
            filePanels: nextFilePanels,
          };
        }
        const nextPanelId = nextPanelIdAfterRemoval(current.panelOrder, panelId);
        return {
          ...current,
          activePanelId: nextPanelId ?? activeEntryId ?? entries[0]?.id ?? null,
          panelOrder: current.panelOrder.filter((id) => id !== panelId),
          filePanelIds: nextFilePanelIds,
          filePanels: nextFilePanels,
        };
      });
      if (shouldCloseSidebar) {
        onClose();
      }
    },
    [
      activeEntryId,
      entries,
      filePanelIds,
      initialPanelIds.length,
      onClose,
      resolvedActivePanelId,
      updateActiveScopePanelState,
    ],
  );

  const closePreviewEntry = useCallback(
    (entryId: string) => {
      const closedIndex = entries.findIndex((entry) => entry.id === entryId);
      const remainingEntries = entries.filter((entry) => entry.id !== entryId);
      const closedActivePanel = resolvedActivePanelId === entryId;
      const shouldCloseSidebar =
        remainingEntries.length === 0 &&
        filePanelIds.length === 0 &&
        initialPanelIds.length === 0 &&
        resolvedActivePanelId === entryId;
      previewContext?.closePreviewEntry(entryId);
      updateActiveScopePanelState((current) => {
        if (current.activePanelId !== entryId && !closedActivePanel) {
          return { ...current, panelOrder: current.panelOrder.filter((id) => id !== entryId) };
        }
        const nextEntry =
          remainingEntries[Math.max(0, Math.min(closedIndex - 1, remainingEntries.length - 1))] ?? null;
        return {
          ...current,
          activePanelId:
            nextEntry?.id ?? nextPanelIdAfterRemoval(current.panelOrder, entryId) ?? current.filePanelIds[0] ?? null,
          panelOrder: current.panelOrder.filter((id) => id !== entryId),
        };
      });
      if (shouldCloseSidebar) {
        onClose();
      }
    },
    [
      entries,
      filePanelIds.length,
      initialPanelIds.length,
      onClose,
      previewContext,
      resolvedActivePanelId,
      updateActiveScopePanelState,
    ],
  );

  const openPanelEntry = useCallback(
    (entryId: string) => {
      updateActiveScopePanelState((current) => ({
        ...current,
        activePanelId: entryId,
        panelOrder: appendPanelOrder(current.panelOrder, entryId),
      }));
      previewContext?.switchPreview(entryId);
    },
    [previewContext, updateActiveScopePanelState],
  );

  const activateFilesPanel = useCallback(
    (panelId: string) => {
      updateActiveScopePanelState((current) =>
        current.filePanels[panelId] ? { ...current, activePanelId: panelId } : current,
      );
    },
    [updateActiveScopePanelState],
  );

  const openInitialPanel = useCallback(() => {
    updateActiveScopePanelState((current) => {
      const nextPanelSeq = current.nextPanelSeq + 1;
      const panelId = `${INITIAL_PANEL_ID_PREFIX}${nextPanelSeq}`;
      return {
        ...current,
        activePanelId: panelId,
        panelOrder: [...current.panelOrder, panelId],
        initialPanelIds: [...current.initialPanelIds, panelId],
        nextPanelSeq,
      };
    });
  }, [updateActiveScopePanelState]);

  const activateInitialPanel = useCallback(
    (panelId: string) => {
      updateActiveScopePanelState((current) => ({ ...current, activePanelId: panelId }));
    },
    [updateActiveScopePanelState],
  );

  const closeInitialPanel = useCallback(
    (panelId: string) => {
      const remainingInitialPanels = initialPanelIds.filter((id) => id !== panelId);
      const shouldCloseSidebar =
        resolvedActivePanelId === panelId &&
        remainingInitialPanels.length === 0 &&
        filePanelIds.length === 0 &&
        entries.length === 0;
      updateActiveScopePanelState((current) => {
        const nextInitialPanelIds = current.initialPanelIds.filter((id) => id !== panelId);
        if (current.activePanelId !== panelId) {
          return {
            ...current,
            panelOrder: current.panelOrder.filter((id) => id !== panelId),
            initialPanelIds: nextInitialPanelIds,
          };
        }
        const nextPanelId = nextPanelIdAfterRemoval(current.panelOrder, panelId);
        return {
          ...current,
          activePanelId: nextPanelId ?? activeEntryId ?? entries[0]?.id ?? null,
          panelOrder: current.panelOrder.filter((id) => id !== panelId),
          initialPanelIds: nextInitialPanelIds,
        };
      });
      if (shouldCloseSidebar) {
        onClose();
      }
    },
    [
      activeEntryId,
      entries,
      filePanelIds.length,
      initialPanelIds,
      onClose,
      resolvedActivePanelId,
      updateActiveScopePanelState,
    ],
  );

  const updateFilePanelPreviewPath = useCallback(
    (path: string | null) => {
      const panelId = activeFilePanel?.id;
      if (!panelId) {
        return;
      }
      updateActiveScopePanelState((current) => {
        const panel = current.filePanels[panelId];
        if (!panel) {
          return current;
        }
        return {
          ...current,
          filePanels: {
            ...current.filePanels,
            [panelId]: {
              ...panel,
              filePreviewPath: path,
              filePreviewRequestId: panel.filePreviewRequestId + 1,
            },
          },
        };
      });
    },
    [activeFilePanel?.id, updateActiveScopePanelState],
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
            <div className={styles.rightSidebarTabArea}>
              <div className={styles.rightSidebarTabs} role="tablist" aria-label="侧边栏窗口">
                {orderedPanelIds.map((panelId) => {
                  const filePanel = filePanels[panelId];
                  if (filePanel) {
                    const active = resolvedActivePanelId === panelId;
                    return (
                      <div className={styles.rightSidebarTab} data-active={active ? "true" : "false"} key={panelId}>
                        <button
                          className={styles.rightSidebarTabMain}
                          type="button"
                          role="tab"
                          aria-selected={active}
                          title="文件"
                          onClick={() => activateFilesPanel(panelId)}
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
                            closeFilesPanel(panelId);
                          }}
                        >
                          <X size={11} />
                        </button>
                      </div>
                    );
                  }
                  if (initialPanelIds.includes(panelId)) {
                    const title = initialPanelTitle(panelId);
                    const active = resolvedActivePanelId === panelId;
                    return (
                      <div className={styles.rightSidebarTab} data-active={active ? "true" : "false"} key={panelId}>
                        <button
                          className={styles.rightSidebarTabMain}
                          type="button"
                          role="tab"
                          aria-selected={active}
                          title={title}
                          onClick={() => activateInitialPanel(panelId)}
                        >
                          <FileText size={12} />
                          <span>{title}</span>
                        </button>
                        <button
                          className={styles.rightSidebarTabClose}
                          type="button"
                          aria-label={`关闭侧边栏窗口 ${title}`}
                          title={`关闭侧边栏窗口 ${title}`}
                          onClick={(event) => {
                            event.stopPropagation();
                            closeInitialPanel(panelId);
                          }}
                        >
                          <X size={11} />
                        </button>
                      </div>
                    );
                  }
                  const entry = entries.find((item) => item.id === panelId);
                  if (!entry) {
                    return null;
                  }
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
              <button
                className={styles.rightSidebarAddTab}
                type="button"
                aria-label="新建侧边栏页面"
                title="新建侧边栏页面"
                onClick={openInitialPanel}
              >
                <Plus size={15} />
              </button>
            </div>
            <div className={styles.rightSidebarPanelControls}>
              {controls}
            </div>
          </div>
          {showFilesPanel &&
          filePanelRenderContext?.runtime &&
          (filePanelRenderContext.sessionId || filePanelRenderContext.workspaceId) ? (
            <div className={styles.rightSidebarBody} data-content="files">
              <Suspense fallback={<RightSidebarLoading label="正在加载文件" />}>
                <LazyWorkspaceFileBrowser
                  key={`${activeScopeKey}:${activeFilePanel?.id ?? "files"}`}
                  label={filePanelRenderContext.workspaceLabel}
                  runtime={filePanelRenderContext.runtime}
                  workspaceId={filePanelRenderContext.workspaceId}
                  sessionId={filePanelRenderContext.sessionId}
                  previewPath={activeFilePanel?.filePreviewPath ?? null}
                  previewRequestId={activeFilePanel?.filePreviewRequestId ?? 0}
                  onQuoteSelection={filePanelRenderContext.onQuoteSelection ? filePanelQuoteSelection : undefined}
                  onStartChatFromAnnotation={filePanelRenderContext.onStartChatFromAnnotation}
                  onPreviewPathChange={updateFilePanelPreviewPath}
                />
              </Suspense>
            </div>
          ) : activeRequest ? (
            <div className={styles.rightSidebarBody} data-content="preview">
              <ResizePreviewSkeleton className={styles.rightSidebarResizeSkeleton} />
              <Suspense fallback={<RightSidebarLoading label="正在加载预览" />}>
                <LazyFilePreview
                  breadcrumbRootLabel={
                    activeRequest.type === "content" && !activeRequest.sourcePath
                      ? undefined
                      : activeRenderContext?.workspaceLabel
                  }
                  workspaceId={activeRenderContext?.workspaceId}
                  sessionId={activeRenderContext?.sessionId}
                  request={activeRequest}
                  runtime={activeRenderContext?.runtime}
                  onQuoteSelection={activeRenderContext?.onQuoteSelection ? activePreviewQuoteSelection : undefined}
                  onStartChatFromAnnotation={activeRenderContext?.onStartChatFromAnnotation}
                  chrome="panel"
                />
              </Suspense>
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

function RightSidebarLoading({ label }: { label: string }) {
  return (
    <div className={styles.rightSidebarLoading} role="status" aria-label={label}>
      <div className={styles.rightSidebarLoadingSkeleton} aria-hidden="true">
        <span />
        <span />
        <span />
        <span />
      </div>
      <span>{label}</span>
    </div>
  );
}

function previewOpenStamp(entry: { id: string; openedAt: number } | null): string | null {
  return entry ? `${entry.id}:${entry.openedAt}` : null;
}

function ResizePreviewSkeleton({ className }: { className: string }) {
  return (
    <div className={className} aria-hidden="true" data-resize-preview-skeleton="true">
      <span />
      <span />
      <span />
      <span />
    </div>
  );
}

function sameRightSidebarScopePanelState(
  left: RightSidebarScopePanelState,
  right: RightSidebarScopePanelState,
): boolean {
  return (
    left.activePanelId === right.activePanelId &&
    left.nextPanelSeq === right.nextPanelSeq &&
    sameStringArray(left.panelOrder, right.panelOrder) &&
    sameStringArray(left.filePanelIds, right.filePanelIds) &&
    sameFilePanels(left, right) &&
    sameStringArray(left.initialPanelIds, right.initialPanelIds)
  );
}

type LegacyRightSidebarScopePanelState = Partial<RightSidebarScopePanelState> & {
  filesOpen?: boolean;
  initialPanelSeq?: number;
  filePreviewPath?: string | null;
  filePreviewRequestId?: number;
};

function normalizeRightSidebarScopePanelState(
  state: LegacyRightSidebarScopePanelState | null | undefined,
): RightSidebarScopePanelState {
  const filePanels = { ...(state?.filePanels ?? {}) };
  let filePanelIds = state?.filePanelIds ?? [];
  if (filePanelIds.length === 0 && state?.filesOpen) {
    filePanelIds = [LEGACY_FILES_PANEL_ID];
    filePanels[LEGACY_FILES_PANEL_ID] = {
      id: LEGACY_FILES_PANEL_ID,
      filePreviewPath: state.filePreviewPath ?? null,
      filePreviewRequestId: state.filePreviewRequestId ?? 0,
    };
  }
  const initialPanelIds = state?.initialPanelIds ?? [];
  const nextPanelSeq = Math.max(
    state?.nextPanelSeq ?? state?.initialPanelSeq ?? 0,
    maxPanelSeq([...filePanelIds, ...initialPanelIds]),
  );
  const panelOrder = orderedUniquePanelIds(state?.panelOrder ?? [], [
    ...filePanelIds,
    ...initialPanelIds,
  ]);

  return {
    ...EMPTY_RIGHT_SIDEBAR_SCOPE_STATE,
    ...state,
    panelOrder,
    filePanelIds,
    filePanels,
    initialPanelIds,
    nextPanelSeq,
  };
}

function activateOrCreateFilePanel(
  state: RightSidebarScopePanelState,
  options: { path?: string | null; requestId?: number; preferExisting?: boolean } = {},
): RightSidebarScopePanelState {
  const activeFilePanelId = activeFilePanelIdForState(state);
  const reusableFilePanelId = activeFilePanelId ?? (options.preferExisting ? state.filePanelIds[0] : null);
  if (reusableFilePanelId) {
    return activateExistingFilePanel(state, reusableFilePanelId, options);
  }

  const activeInitialPanelId = activeInitialPanelIdForState(state);
  const nextPanelSeq = activeInitialPanelId ? state.nextPanelSeq : state.nextPanelSeq + 1;
  const panelId = activeInitialPanelId ?? `${FILES_PANEL_ID_PREFIX}${nextPanelSeq}`;
  return {
    ...state,
    activePanelId: panelId,
    panelOrder: activeInitialPanelId ? state.panelOrder : [...state.panelOrder, panelId],
    filePanelIds: [...state.filePanelIds, panelId],
    filePanels: {
      ...state.filePanels,
      [panelId]: {
        id: panelId,
        filePreviewPath: hasPanelPathOption(options) ? options.path ?? null : null,
        filePreviewRequestId: options.requestId ?? 0,
      },
    },
    initialPanelIds: activeInitialPanelId
      ? state.initialPanelIds.filter((id) => id !== activeInitialPanelId)
      : state.initialPanelIds,
    nextPanelSeq,
  };
}

function activateExistingFilePanel(
  state: RightSidebarScopePanelState,
  panelId: string,
  options: { path?: string | null; requestId?: number },
): RightSidebarScopePanelState {
  const panel = state.filePanels[panelId];
  if (!panel) {
    return state;
  }
  if (!hasPanelPathOption(options) && !options.requestId) {
    return { ...state, activePanelId: panelId };
  }
  return {
    ...state,
    activePanelId: panelId,
    filePanels: {
      ...state.filePanels,
      [panelId]: {
        ...panel,
        filePreviewPath: hasPanelPathOption(options) ? options.path ?? null : panel.filePreviewPath,
        filePreviewRequestId: options.requestId
          ? Math.max(panel.filePreviewRequestId + 1, options.requestId)
          : panel.filePreviewRequestId,
      },
    },
  };
}

function activeFilePanelIdForState(state: RightSidebarScopePanelState): string | null {
  return state.activePanelId && state.filePanels[state.activePanelId] ? state.activePanelId : null;
}

function activeInitialPanelIdForState(state: RightSidebarScopePanelState): string | null {
  return state.activePanelId && state.initialPanelIds.includes(state.activePanelId) ? state.activePanelId : null;
}

function orderedRightSidebarPanelIds(state: RightSidebarScopePanelState, entryIds: string[]): string[] {
  return orderedUniquePanelIds(state.panelOrder, [...state.filePanelIds, ...state.initialPanelIds, ...entryIds]);
}

function orderedUniquePanelIds(preferredOrder: string[], panelIds: string[]): string[] {
  const availableIds = new Set(panelIds);
  const orderedIds = preferredOrder.filter((id) => availableIds.delete(id));
  return [...orderedIds, ...panelIds.filter((id) => availableIds.delete(id))];
}

function appendPanelOrder(panelOrder: string[], panelId: string): string[] {
  return panelOrder.includes(panelId) ? panelOrder : [...panelOrder, panelId];
}

function nextPanelIdAfterRemoval(panelOrder: string[], removedPanelId: string): string | null {
  const panelIndex = panelOrder.indexOf(removedPanelId);
  const remainingPanelOrder = panelOrder.filter((id) => id !== removedPanelId);
  if (remainingPanelOrder.length === 0) {
    return null;
  }
  if (panelIndex === -1) {
    return remainingPanelOrder[0] ?? null;
  }
  return remainingPanelOrder[Math.max(0, Math.min(panelIndex, remainingPanelOrder.length - 1))] ?? null;
}

function hasPanelPathOption(options: { path?: string | null }): boolean {
  return Object.prototype.hasOwnProperty.call(options, "path");
}

function maxPanelSeq(panelIds: string[]): number {
  return panelIds.reduce((maxSeq, panelId) => {
    const prefix = panelId.startsWith(INITIAL_PANEL_ID_PREFIX) ? INITIAL_PANEL_ID_PREFIX : FILES_PANEL_ID_PREFIX;
    if (!panelId.startsWith(prefix)) {
      return maxSeq;
    }
    const seq = Number(panelId.slice(prefix.length));
    return Number.isFinite(seq) ? Math.max(maxSeq, seq) : maxSeq;
  }, 0);
}

function sameStringArray(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameFilePanels(left: RightSidebarScopePanelState, right: RightSidebarScopePanelState): boolean {
  return left.filePanelIds.every((panelId) => {
    const leftPanel = left.filePanels[panelId];
    const rightPanel = right.filePanels[panelId];
    return (
      Boolean(leftPanel) &&
      Boolean(rightPanel) &&
      leftPanel.filePreviewPath === rightPanel.filePreviewPath &&
      leftPanel.filePreviewRequestId === rightPanel.filePreviewRequestId
    );
  });
}

function initialPanelTitle(panelId: string): string {
  return "新tab";
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
